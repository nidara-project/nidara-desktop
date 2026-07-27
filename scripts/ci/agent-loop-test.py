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
# XDG_CONFIG_HOME and persisting its session under a temp XDG_STATE_HOME — both
# per case, so cases cannot leak history into each other and running this on a
# real machine cannot touch your own conversation. Needs only: gjs, curl, python3
# (and the Secret-1 typelib the daemon imports — gir1.2-secret-1 on Debian/Ubuntu).
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

# The Anthropic lane is driven through a stub `curl` (see make_stub_curl): its
# endpoint is not configurable, so there is nothing to point at a local mock.
# This signature must come back byte-for-byte in the next request's assistant
# turn — that is the whole assertion.
SIG = "TESTSIG-do-not-alter/AAECAwQ="


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


# ── The Anthropic lane: a stub `curl` instead of a mock server ────────────────
# buildAnthropicReq hardcodes api.anthropic.com (deliberately — an env-settable
# base URL would be a place to redirect a user's API key), so this lane cannot be
# pointed at a local socket. Standing in for `curl` gets the same coverage and
# more: the request body the daemon actually built is captured on disk, so the
# test asserts the BYTES, not just the outcome.
STUB_CURL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
rec = pathlib.Path(os.environ["NIDARA_TEST_REC"])
body = sys.stdin.read()
rec.joinpath("req-%d.json" % (len(list(rec.glob("req-*.json"))) + 1)).write_text(body)
try:
    msgs = json.loads(body).get("messages", [])
except Exception:
    msgs = []
after_tool = any(
    isinstance(m.get("content"), list)
    and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in m["content"])
    for m in msgs
)
def ev(kind, data):
    sys.stdout.write("event: %s\ndata: %s\n\n" % (kind, json.dumps(data)))
ev("message_start", {"type": "message_start", "message": {"usage": {
    "input_tokens": 11, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})
if not after_tool:
    # A thinking block exactly as it arrives with display "omitted" (the default
    # on Opus 5 / 4.8 / 4.7): opens empty, receives ONE signature_delta, closes.
    ev("content_block_start", {"type": "content_block_start", "index": 0,
       "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
    ev("content_block_delta", {"type": "content_block_delta", "index": 0,
       "delta": {"type": "signature_delta", "signature": "@SIG@"}})
    ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    ev("content_block_start", {"type": "content_block_start", "index": 1,
       "content_block": {"type": "tool_use", "id": "toolu_test1", "name": "@TOOL@", "input": {}}})
    half = len("@ARGS@") // 2
    ev("content_block_delta", {"type": "content_block_delta", "index": 1,
       "delta": {"type": "input_json_delta", "partial_json": "@ARGS@"[:half]}})
    ev("content_block_delta", {"type": "content_block_delta", "index": 1,
       "delta": {"type": "input_json_delta", "partial_json": "@ARGS@"[half:]}})
    ev("content_block_stop", {"type": "content_block_stop", "index": 1})
    ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use"},
       "usage": {"output_tokens": 9, "output_tokens_details": {"thinking_tokens": 5}}})
else:
    ev("content_block_start", {"type": "content_block_start", "index": 0,
       "content_block": {"type": "text", "text": ""}})
    ev("content_block_delta", {"type": "content_block_delta", "index": 0,
       "delta": {"type": "text_delta", "text": "@FINAL@"}})
    ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
       "usage": {"output_tokens": 12}})
ev("message_stop", {"type": "message_stop"})
sys.stdout.flush()
# Mirror the -w write-out marker the daemon parses off stderr.
sys.stderr.write("nidara-http:200 nidara-retry:\n")
'''


def make_stub_curl(bind: Path, rec: Path):
    src = (STUB_CURL.replace("@SIG@", SIG).replace("@TOOL@", TOOL)
           .replace("@ARGS@", ARGS.replace('"', '\\"')).replace("@FINAL@", FINAL))
    (bind / "curl").write_text(src)
    (bind / "curl").chmod(0o755)


def drive_daemon(port: int, anthropic_rec: Path | None = None):
    """Spawn a fresh daemon, send one user turn, return (events, stderr_lines)."""
    tmp = Path(tempfile.mkdtemp(prefix="nidara-agent-test-"))
    try:
        (tmp / "nidara").mkdir()
        # Empty provider → the keyring is never touched (no D-Bus in CI); the mock
        # needs no key anyway.
        (tmp / "nidara" / "ai.json").write_text(json.dumps({
            "brainBackend": "anthropic" if anthropic_rec else "openai",
            "brainProvider": "",
            "brainModel": "mock",
            "brainEndpoint": f"http://127.0.0.1:{port}/v1",
        }))
        bind = tmp / "bin"
        bind.mkdir()
        make_stub_ags(bind)
        if anthropic_rec:
            make_stub_curl(bind, anthropic_rec)

        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = str(tmp)
        # The daemon persists its conversation under XDG_STATE_HOME and RESTORES it
        # on startup, so this has to be per-case or "a fresh daemon" is a lie: the
        # previous case's history would arrive in request 1 and the Anthropic stub,
        # which reads "round 2" off the presence of a tool_result anywhere in the
        # messages, would answer the final text and skip the round-trip under test.
        # It also keeps the test off the developer's own conversation.
        env["XDG_STATE_HOME"] = str(tmp / "state")
        env["PATH"] = f"{bind}:{env.get('PATH', '')}"
        env.setdefault("LANG", "en_US.UTF-8")
        if anthropic_rec:
            env["NIDARA_TEST_REC"] = str(anthropic_rec)

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

        # ── Scenario 3: Anthropic lane — thinking blocks echoed back verbatim ─
        # The rule (Anthropic docs, "preserving thinking blocks"): when you return
        # a tool result, the assistant turn must carry its thinking blocks back
        # unmodified, or the request 400s. The daemon REBUILDS that message, so
        # this is a standing regression risk, and it only bites on models where
        # thinking is on — which now includes the default flagship. Asserted on the
        # captured request bodies rather than on a live provider's blessing.
        rec = Path(tempfile.mkdtemp(prefix="nidara-agent-rec-"))
        try:
            events, stderr_lines = drive_daemon(port, anthropic_rec=rec)
            problems = []
            reqs = sorted(rec.glob("req-*.json"))
            if len(reqs) < 2:
                problems.append(f"expected 2 requests (tool call + follow-up), got {len(reqs)}")
            else:
                first = json.loads(reqs[0].read_text())
                second = json.loads(reqs[1].read_text())
                if not first.get("tools"):
                    problems.append("request 1 carried no tools")
                sys_blocks = first.get("system") or []
                if not (sys_blocks and sys_blocks[0].get("cache_control")):
                    problems.append("request 1 lost the system cache breakpoint")
                asst = [m for m in second.get("messages", []) if m.get("role") == "assistant"]
                if not asst:
                    problems.append("request 2 had no assistant turn to echo")
                else:
                    blocks = asst[-1].get("content") or []
                    kinds = [b.get("type") for b in blocks]
                    if not blocks or blocks[0].get("type") != "thinking":
                        problems.append(f"thinking block not echoed first — got {kinds}")
                    else:
                        tb = blocks[0]
                        if tb.get("signature") != SIG:
                            problems.append(f"signature altered or dropped: {tb.get('signature')!r}")
                        if "cache_control" in tb:
                            problems.append("cache breakpoint landed ON the thinking block (modifies it)")
                    if "tool_use" not in kinds:
                        problems.append(f"tool_use missing from the echoed turn — got {kinds}")
                    results = [b for m in second["messages"] if isinstance(m.get("content"), list)
                               for b in m["content"] if b.get("type") == "tool_result"]
                    if not results:
                        problems.append("no tool_result in request 2")
            text = "".join(e.get("text", "") for e in events if e.get("t") == "delta")
            if FINAL not in text:
                problems.append(f"final answer missing (streamed text: {text!r})")
            if not any("think=5" in l for l in stderr_lines):
                problems.append("thinking tokens not read from usage (no think=5 in telemetry)")
            report("anthropic: thinking blocks survive the tool round-trip", problems, events, stderr_lines)
        finally:
            shutil.rmtree(rec, ignore_errors=True)

        return 1 if failures else 0
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
