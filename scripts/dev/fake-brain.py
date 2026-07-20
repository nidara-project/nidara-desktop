#!/usr/bin/env python3
# fake-brain.py — a minimal OpenAI-compatible streaming server for exercising
# bin/nidara-agent WITHOUT a real API key or network (same spirit as the other
# scripts/dev/fake-* helpers). It scripts exactly one tool-use round-trip:
#
#   round 1 (user turn, no tool result yet)  → stream ONE tool_call
#   round 2 (a role="tool" message present)  → stream a final text answer
#
# Point the daemon at it (ai.json):
#   "brainBackend": "openai",
#   "brainEndpoint": "http://localhost:11435/v1",
#   "brainModel": "mock"
# then feed the daemon a user message on stdin and watch it call the tool via
# `ags request` and answer.
#
# Configure the scripted tool via env (defaults = a harmless read):
#   FAKE_BRAIN_TOOL   tool name to call          (default: get_config)
#   FAKE_BRAIN_ARGS   JSON arguments object       (default: {"key":"appearance.accent"})
#   FAKE_BRAIN_FINAL  final assistant text        (default: "Done.")
#   PORT              listen port                 (default: 11435)
#
#   python3 scripts/dev/fake-brain.py            # read-only loop test
#   FAKE_BRAIN_TOOL=set_config \
#     FAKE_BRAIN_ARGS='{"key":"nightlight.enabled","value":"true"}' \
#     python3 scripts/dev/fake-brain.py          # gate / write-path test

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOL = os.environ.get("FAKE_BRAIN_TOOL", "get_config")
ARGS = os.environ.get("FAKE_BRAIN_ARGS", '{"key":"appearance.accent"}')
FINAL = os.environ.get("FAKE_BRAIN_FINAL", "Done.")
PORT = int(os.environ.get("PORT", "11435"))


def chunk(delta=None, finish=None, usage=None):
    """One OpenAI chat.completion.chunk as an SSE `data:` line."""
    obj = {"id": "fake-1", "object": "chat.completion.chunk", "model": "mock"}
    if usage is not None:
        obj["usage"] = usage
        obj["choices"] = []
    else:
        obj["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
    return "data: " + json.dumps(obj) + "\n\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(body)
        except Exception:
            req = {}
        messages = req.get("messages", [])
        has_tool_result = any(m.get("role") == "tool" for m in messages)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def send(s):
            self.wfile.write(s.encode())
            self.wfile.flush()

        if not has_tool_result:
            # Round 1: emit a single tool_call, arguments split across two chunks
            # to exercise the daemon's partial-JSON accumulation.
            send(chunk(delta={"role": "assistant", "content": ""}))
            send(chunk(delta={"tool_calls": [
                {"index": 0, "id": "call_1", "type": "function",
                 "function": {"name": TOOL, "arguments": ""}}]}))
            half = len(ARGS) // 2
            send(chunk(delta={"tool_calls": [
                {"index": 0, "function": {"arguments": ARGS[:half]}}]}))
            send(chunk(delta={"tool_calls": [
                {"index": 0, "function": {"arguments": ARGS[half:]}}]}))
            send(chunk(finish="tool_calls"))
        else:
            # Round 2: final answer, text split across two chunks.
            send(chunk(delta={"role": "assistant", "content": FINAL[:1]}))
            send(chunk(delta={"content": FINAL[1:]}))
            send(chunk(finish="stop"))

        send(chunk(usage={"prompt_tokens": 12, "completion_tokens": 7}))
        send("data: [DONE]\n\n")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"fake-brain: OpenAI-compatible mock on http://127.0.0.1:{PORT}/v1 "
          f"(tool={TOOL} args={ARGS})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
