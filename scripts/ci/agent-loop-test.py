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

# Computer-use scenario. `role` is omitted while `occurrence` is given ON PURPOSE:
# nidara-click reads the tail POSITIONALLY, so an omitted role has to be padded
# with "" — drop it and the occurrence lands in the role slot, filtering for a
# control whose role is "2" (which matches nothing, silently).
CLICK_ARGS = '{"app":"nautilus","node":"Trash","occurrence":2}'
CLICK_ARGV = ["app", "nautilus", "Trash", "", "2"]

# The Anthropic lane is driven through a stub `curl` (see make_stub_curl): its
# endpoint is not configurable, so there is nothing to point at a local mock.
# This signature must come back byte-for-byte in the next request's assistant
# turn — that is the whole assertion.
SIG = "TESTSIG-do-not-alter/AAECAwQ="


# ── The mock LLM (OpenAI-compatible streaming) ───────────────────────────────
class Mock(BaseHTTPRequestHandler):
    mode = "retry"        # "retry" | "client_error" | "computer_use", per scenario
    hits = 0
    served_5xx = False
    last_tools = []       # tool NAMES offered in the most recent request
    last_messages = []    # messages of the most recent request (tool results included)

    @classmethod
    def reset(cls, mode):
        cls.mode, cls.hits, cls.served_5xx = mode, 0, False
        cls.last_tools = []
        cls.last_messages = []

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
            payload = json.loads(body)
        except Exception:
            payload = {}
        messages = payload.get("messages", [])
        Mock.last_tools = [t.get("function", {}).get("name") for t in payload.get("tools", [])]
        Mock.last_messages = messages
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        tool_results = sum(1 for m in messages if m.get("role") == "tool")

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

        def call_tool(name, args, call_id):
            send(self._chunk(delta={"role": "assistant", "content": ""}))
            send(self._chunk(delta={"tool_calls": [
                {"index": 0, "id": call_id, "type": "function",
                 "function": {"name": name, "arguments": ""}}]}))
            half = len(args) // 2
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": args[:half]}}]}))
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": args[half:]}}]}))
            send(self._chunk(finish="tool_calls"))

        if Mock.mode == "computer_use":
            # Three helper-backed calls in one turn: a pointer click that SUCCEEDS
            # (asserted on the argv the helper received), a perception call that
            # returns a tree (asserted on the projection applied to it), and one
            # the helper REFUSES (asserted on the result being marked failed).
            if tool_results == 0:
                call_tool("click_app", CLICK_ARGS, "call_click")
            elif tool_results == 1:
                call_tool("query_app", '{"app":"nautilus"}', "call_query")
            elif tool_results == 2:
                call_tool("query_app", "{}", "call_refused")
            else:
                send(self._chunk(delta={"role": "assistant", "content": FINAL[:1]}))
                send(self._chunk(delta={"content": FINAL[1:]}))
                send(self._chunk(finish="stop"))
        elif not has_tool_result:
            # Round 1: one tool_call, arguments split across two chunks (exercises
            # the daemon's partial-JSON accumulation).
            call_tool(TOOL, ARGS, "call_1")
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


# ── The computer-use helpers: stubs that RECORD their argv ───────────────────
# The daemon's job here is to translate a tool call into the right command line
# for a helper that enforces the gate, verifies focus and drives the pointer.
# There is no compositor and no AT-SPI bus in CI, so the helpers are replaced by
# recorders: what is under test is the argv, which is exactly where a silent
# defect lives (a dropped positional pad aims at the wrong control and every
# layer still reports success).
STUB_HELPER = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ["NIDARA_TEST_ARGV"], "@NAME@.json").write_text(json.dumps(sys.argv[1:]))
print(json.dumps(@REPLY@))
'''

# nidara-a11y answers differently depending on whether it was given an app, so one
# stub covers both halves under test: a real-shaped TREE (projection) and a gate
# REFUSAL (the daemon must mark that result failed, not "ok" with an error inside).
# The ancestor path is deliberately deep AND long-linked — that is the shape
# measured on a live session (a Telegram list item's accessible name IS the whole
# message, repeated down every descendant's chain) and the reason the projection
# exists at all.
LONG_LINK = "list item#" + ("verbose accessible name " * 12)
# The tree shape that broke it live: a long run of identical rows FIRST and the
# control the user asked for LAST. Document order puts a GTK app's header bar at
# the end, so a positional cut loses exactly the buttons worth pressing — measured
# on Nautilus, where "Show Sidebar" sat at node 157 of 175, byte 55,313 of 60,367.
STUB_A11Y = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ["NIDARA_TEST_ARGV"], "nidara-a11y.json").write_text(json.dumps(sys.argv[1:]))
if not sys.argv[1:]:
    print(json.dumps({"error": "computer-use is disabled — enable it in Settings → AI"}))
    raise SystemExit
deep = " > ".join(["frame#Files", "panel", "@LONG@", "scroll pane", "list"])
rows = [{"id": "file-%03d.txt" % i, "role": "table row", "type": "table row", "text": None,
         "states": ["sensitive", "showing", "selectable"], "actions": ["click"],
         "visible": True, "window": "Files", "bounds": {"x": 0, "y": i, "w": 900, "h": 32},
         "path": deep} for i in range(120)]
tail = {"id": "Show Sidebar", "role": "toggle button", "type": "toggle button", "text": None,
        "states": ["sensitive", "showing"], "actions": ["click"], "visible": True,
        "window": "Files", "bounds": {"x": 1, "y": 2, "w": 34, "h": 34},
        "path": "frame#Files > panel > header bar"}
print(json.dumps({"source": "atspi", "app": sys.argv[1],
                  "count": len(rows) + 1, "nodes": rows + [tail]}))
'''


def make_stub_helpers(bind: Path):
    # A successful pointer action, the shape nidara-click prints.
    p = bind / "nidara-click"
    p.write_text(STUB_HELPER.replace("@NAME@", "nidara-click")
                 .replace("@REPLY@", repr({"ok": True, "app": "nautilus", "mode": "app"})))
    p.chmod(0o755)
    p = bind / "nidara-a11y"
    p.write_text(STUB_A11Y.replace("@LONG@", LONG_LINK))
    p.chmod(0o755)


def make_stub_curl(bind: Path, rec: Path):
    src = (STUB_CURL.replace("@SIG@", SIG).replace("@TOOL@", TOOL)
           .replace("@ARGS@", ARGS.replace('"', '\\"')).replace("@FINAL@", FINAL))
    (bind / "curl").write_text(src)
    (bind / "curl").chmod(0o755)


def drive_daemon(port: int, anthropic_rec: Path | None = None,
                 ai_extra: dict | None = None, argv_rec: Path | None = None,
                 prompt: str = "make the accent blue"):
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
            **(ai_extra or {}),
        }))
        bind = tmp / "bin"
        bind.mkdir()
        make_stub_ags(bind)
        if argv_rec:
            make_stub_helpers(bind)
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
        if argv_rec:
            env["NIDARA_TEST_ARGV"] = str(argv_rec)

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

        proc.stdin.write(json.dumps({"t": "user", "text": prompt}) + "\n")
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

        # ── Scenario 4: computer-use is gate-CONDITIONED, and the argv is right ─
        # Two properties, both invisible from the outside:
        #  (1) OFFERED, not merely permitted — with the gates off (the shipped
        #      default) the schemas must not be in the request at all. A model
        #      told about a tool it cannot use promises the user something it
        #      cannot deliver, and the schemas are re-sent on every step to do it.
        #  (2) The argv handed to the helper is what the helper's positional CLI
        #      means. Getting it wrong aims at a different control while every
        #      layer still reports success.
        Mock.reset("computer_use")
        events, stderr_lines = drive_daemon(port, prompt="empty the trash in files")
        problems = []
        offered = [t for t in Mock.last_tools if t in ("query_app", "click_app", "do_app_action")]
        if offered:
            problems.append(f"computer-use tools offered with both gates OFF: {offered}")
        report("computer-use: not offered while gated off", problems, events, stderr_lines)

        Mock.reset("computer_use")
        argv_rec = Path(tempfile.mkdtemp(prefix="nidara-agent-argv-"))
        try:
            events, stderr_lines = drive_daemon(
                port,
                ai_extra={"allowComputerUse": True, "allowComputerControl": True},
                argv_rec=argv_rec,
                prompt="empty the trash in files",
            )
            problems = []
            for expected in ("query_app", "click_app", "do_app_action", "drag_app"):
                if expected not in Mock.last_tools:
                    problems.append(f"{expected} missing from the tool list with both gates on")
            click = argv_rec / "nidara-click.json"
            if not click.exists():
                problems.append("nidara-click was never invoked")
            else:
                got = json.loads(click.read_text())
                if got != CLICK_ARGV:
                    problems.append(f"nidara-click argv wrong: {got} != {CLICK_ARGV}")
            results = [e for e in events if e.get("t") == "toolresult"]
            if len(results) < 3:
                problems.append(f"expected 3 tool results (click + query + refusal), got {len(results)}")
            else:
                if not results[0].get("ok"):
                    problems.append("the successful click was reported as failed")
                if not results[1].get("ok"):
                    problems.append("a successful query_app was reported as failed")
                # The refusal half: nidara-a11y answers {"error": …} and the daemon
                # must mark THAT result failed.
                if results[2].get("ok"):
                    problems.append("a helper refusal was reported as a SUCCESSFUL tool result")
            # The projection. An accessibility tree is far bigger than a turn's
            # budget (measured live: 102 KB for Nautilus, 503 KB for Telegram
            # against a 24 KB cap) and a plain head-cut loses the wrong end: the
            # control the user named comes LAST in document order, behind the
            # content. Three assertions, each for one half of the fix.
            tree = next((m.get("content", "") for m in Mock.last_messages
                         if m.get("role") == "tool" and "table row" in str(m.get("content", ""))), "")
            if not tree:
                problems.append("the query_app result never reached the next request")
            else:
                if LONG_LINK in tree:
                    problems.append("the ancestor path was relayed at full length (not trimmed)")
                elif "… > " not in tree:
                    problems.append(f"the ancestor path was not trimmed: {tree[:200]!r}")
                if '"omitted"' not in tree:
                    problems.append("a run of 120 identical rows was not collapsed")
                # THE regression that started this: the button after the list.
                if "Show Sidebar" not in tree:
                    problems.append("the control AFTER the long list did not survive the projection")
                if '"visible"' in tree or '"window"' in tree.split('"nodes"')[0][40:]:
                    problems.append("per-node noise (visible/window) was not leaned out")
            text = "".join(e.get("text", "") for e in events if e.get("t") == "delta")
            if FINAL not in text:
                problems.append(f"turn did not complete (streamed text: {text!r})")
            report("computer-use: offered when gated on, argv + refusal honest", problems, events, stderr_lines)
        finally:
            shutil.rmtree(argv_rec, ignore_errors=True)

        return 1 if failures else 0
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
