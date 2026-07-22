#!/usr/bin/env python3
# agent-loop-test.py — a hermetic integration test for bin/nidara-agent.
#
# WHY THIS EXISTS: every serious Assistant bug so far was a WIRE-SHAPE bug in the
# daemon's stream parsing — a tool call that finishes with "stop" instead of
# "tool_calls", arguments split across chunks, a provider that omits `index`. Each
# was caught by hand, in a live session, after it shipped. This test replays those
# exact shapes against the real daemon and asserts the tool-use loop still works,
# so a regression fails in CI instead of in the user's face. It also pins both
# halves of the 5xx retry policy:
#   - a transient 503 before the first token MUST be retried and then succeed;
#   - a 4xx (client error) MUST NOT be retried — it surfaces immediately.
#
# HERMETIC: no network, no API key, no real provider, no running shell. A tiny
# OpenAI-compatible mock stands in for the LLM; a stub `ags` on PATH stands in for
# the shell so tool execution returns a value instead of failing. The daemon runs
# exactly as installed (gjs), reading a throwaway ai.json under a temp
# XDG_CONFIG_HOME. Needs only: gjs, curl, python3 (and the Secret-1 typelib the
# daemon imports — gir1.2-secret-1 on Debian/Ubuntu).
#
# Run locally:  python3 scripts/ci/agent-loop-test.py
# Exit 0 = pass, non-zero = a failure (with the daemon's telemetry printed).

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DAEMON = REPO / "bin" / "nidara-agent"

TOOL = "set_config"
ARGS = '{"key":"appearance.accent","value":"blue"}'
FINAL = "Done — the accent is now blue."
DEADLINE_S = 30


# ── The mock LLM (OpenAI-compatible streaming) ───────────────────────────────
class Mock(BaseHTTPRequestHandler):
    mode = "retry"        # "retry" | "client_error", set per scenario
    hits = 0
    served_5xx = False

    @classmethod
    def reset(cls, mode):
        cls.mode, cls.hits, cls.served_5xx = mode, 0, False

    def log_message(self, *a):
        pass  # quiet

    @staticmethod
    def _chunk(delta=None, finish=None, usage=None):
        obj = {"id": "m1", "object": "chat.completion.chunk", "model": "mock"}
        if usage is not None:
            obj["usage"], obj["choices"] = usage, []
        else:
            obj["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
        return "data: " + json.dumps(obj) + "\n\n"

    def _fail(self, code, message):
        payload = json.dumps({"error": {"message": message}}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        Mock.hits += 1
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            messages = json.loads(body).get("messages", [])
        except Exception:
            messages = []
        has_tool_result = any(m.get("role") == "tool" for m in messages)

        # A 4xx must be surfaced, never retried: fail every request the same way.
        if Mock.mode == "client_error":
            self._fail(400, "invalid api key (test)")
            return

        # retry mode: a transient 503 on first contact, then the normal loop.
        if not has_tool_result and not Mock.served_5xx:
            Mock.served_5xx = True
            self._fail(503, "service unavailable (test)")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def send(s):
            self.wfile.write(s.encode())
            self.wfile.flush()

        if not has_tool_result:
            # Round 1: one tool_call, arguments split across two chunks (exercises
            # the daemon's partial-JSON accumulation).
            send(self._chunk(delta={"role": "assistant", "content": ""}))
            send(self._chunk(delta={"tool_calls": [
                {"index": 0, "id": "call_1", "type": "function",
                 "function": {"name": TOOL, "arguments": ""}}]}))
            half = len(ARGS) // 2
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": ARGS[:half]}}]}))
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": ARGS[half:]}}]}))
            send(self._chunk(finish="tool_calls"))
        else:
            # Round 2: final answer, text split across two chunks.
            send(self._chunk(delta={"role": "assistant", "content": FINAL[:1]}))
            send(self._chunk(delta={"content": FINAL[1:]}))
            send(self._chunk(finish="stop"))

        send(self._chunk(usage={"prompt_tokens": 12, "completion_tokens": 7}))
        send("data: [DONE]\n\n")


# ── Driving the real daemon over stdio ───────────────────────────────────────
def make_stub_ags(bind: Path):
    """A stub `ags` so a tool call returns a value (there is no shell in CI)."""
    (bind / "ags").write_text(
        "#!/bin/sh\n"
        '[ "$1" = request ] || exit 0\n'
        "case \"$2\" in\n"
        "  listActions) printf '%s' "
        "'{\"toggleControlCenter\":{\"desc\":\"Toggle the control center\"},"
        "\"launchApp\":{\"desc\":\"Launch an app\"}}' ;;\n"
        "  describeConfig) printf '%s' "
        "'{\"appearance.accent\":{\"type\":\"string\",\"value\":\"purple\",\"writable\":true}}' ;;\n"
        "  dumpState) printf '%s' '{\"overlays\":{},\"dark\":false}' ;;\n"
        "  getConfig) printf '%s' '{\"appearance.accent\":\"purple\"}' ;;\n"
        "  setConfig) printf '%s' 'appearance.accent = blue' ;;\n"
        "  *) printf '%s' '{}' ;;\n"
        "esac\n"
    )
    (bind / "ags").chmod(0o755)


def drive_daemon(port: int):
    """Spawn a fresh daemon, send one user turn, return (events, stderr_lines)."""
    tmp = Path(tempfile.mkdtemp(prefix="nidara-agent-test-"))
    try:
        (tmp / "nidara").mkdir()
        # Empty provider → the keyring is never touched (no D-Bus in CI); the mock
        # needs no key anyway.
        (tmp / "nidara" / "ai.json").write_text(json.dumps({
            "brainBackend": "openai",
            "brainProvider": "",
            "brainModel": "mock",
            "brainEndpoint": f"http://127.0.0.1:{port}/v1",
        }))
        bind = tmp / "bin"
        bind.mkdir()
        make_stub_ags(bind)

        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = str(tmp)
        env["PATH"] = f"{bind}:{env.get('PATH', '')}"
        env.setdefault("LANG", "en_US.UTF-8")

        proc = subprocess.Popen(
            ["gjs", "-m", str(DAEMON)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, text=True, bufsize=1,
        )

        events, stderr_lines = [], []
        done = threading.Event()

        def read_stdout():
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                events.append(ev)
                if ev.get("t") in ("done", "error"):
                    done.set()

        def read_stderr():
            for line in proc.stderr:
                stderr_lines.append(line.rstrip())

        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

        proc.stdin.write(json.dumps({"t": "user", "text": "make the accent blue"}) + "\n")
        proc.stdin.flush()
        done.wait(DEADLINE_S)

        try:
            proc.stdin.close()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        return events, stderr_lines
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if not DAEMON.exists():
        print(f"FAIL: daemon not found at {DAEMON}", file=sys.stderr)
        return 1
    if not shutil.which("gjs"):
        print("FAIL: gjs is not installed (needed to run the daemon)", file=sys.stderr)
        return 1

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    failures = []

    def report(name, problems, events, stderr_lines):
        if problems:
            failures.append(name)
            print(f"FAIL: {name}", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            print("  --- daemon telemetry (stderr) ---", file=sys.stderr)
            for l in stderr_lines:
                print(f"    {l}", file=sys.stderr)
        else:
            print(f"PASS: {name}")

    try:
        # ── Scenario 1: tool-use loop, with a 503 that MUST be retried past ──
        Mock.reset("retry")
        events, stderr_lines = drive_daemon(port)
        types = [e.get("t") for e in events]
        problems = []
        if "error" in types:
            msg = next((e.get("message") for e in events if e.get("t") == "error"), "?")
            problems.append(f"daemon emitted an error: {msg}")
        if "done" not in types:
            problems.append(f"no 'done' event — turn never completed (events: {types})")
        if not any(e.get("t") == "tool" and e.get("name") == TOOL for e in events):
            problems.append(f"tool '{TOOL}' not parsed/dispatched")
        if not any(e.get("t") == "toolresult" and e.get("ok") for e in events):
            problems.append("no successful toolresult — the tool did not execute")
        text = "".join(e.get("text", "") for e in events if e.get("t") == "delta")
        if FINAL not in text:
            problems.append(f"final answer missing (streamed text: {text!r})")
        if not Mock.served_5xx:
            problems.append("mock never served its scripted 503 (retry path untested)")
        if Mock.hits < 3:
            problems.append(f"expected >=3 requests (503 + tool_call + final), got {Mock.hits} — 503 was NOT retried")
        report("tool-use loop + 5xx retry", problems, events, stderr_lines)

        # ── Scenario 2: a 4xx MUST surface immediately, never be retried ────
        Mock.reset("client_error")
        events, stderr_lines = drive_daemon(port)
        problems = []
        if not any(e.get("t") == "error" for e in events):
            problems.append("no 'error' event — a 4xx must surface, not vanish")
        else:
            msg = next(e.get("message", "") for e in events if e.get("t") == "error")
            if "invalid api key" not in msg:
                problems.append(f"error did not carry the provider message (got: {msg!r})")
        if Mock.hits != 1:
            problems.append(f"a 4xx was retried: expected exactly 1 request, got {Mock.hits}")
        report("4xx surfaces without retry", problems, events, stderr_lines)

        return 1 if failures else 0
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
