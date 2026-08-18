#!/usr/bin/env python3
# fake-greetd.py — a minimal greetd, speaking greetd-ipc(7) on a unix socket, so
# the greeter's login path can be exercised WITHOUT a VM and without a real PAM
# attempt (same spirit as the other scripts/dev/fake-* helpers).
#
#   python3 scripts/dev/fake-greetd.py /tmp/greetd.sock /tmp/req.jsonl &
#   scripts/bundle.sh scripts/dev/greetd-probe.ts /tmp/greetd-probe
#   GREETD_SOCK=/tmp/greetd.sock /tmp/greetd-probe
#
# The password it accepts is GOOD_PASSWORD below; anything else answers with
# {"type":"error","error_type":"auth_error"}, which is the reply the greeter's
# card has to turn into "Wrong password" rather than into a quit().
#
# Every request is appended to the JSONL log, so the test can assert on the
# CONVERSATION and not just on what the client returned — that is where you see
# whether a failed attempt was followed by cancel_session (greetd refuses the
# next create_session if it was not).
#
# --big-endian frames replies with a byte-swapped length prefix. That is the
# NEGATIVE CONTROL: a correct client must fail loudly against it. Use it to
# prove the probe can fail before trusting a green run.
import json, os, socket, struct, sys, threading

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BIG_ENDIAN = "--big-endian" in sys.argv
if len(args) < 2:
    sys.exit("usage: fake-greetd.py <socket-path> <request-log.jsonl> [--big-endian]")

SOCK, LOG = args[0], args[1]
GOOD_PASSWORD = "correct-horse"

if os.path.exists(SOCK):
    os.unlink(SOCK)

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(SOCK)
srv.listen(8)

log_lock = threading.Lock()


def record(obj):
    with log_lock, open(LOG, "a") as f:
        f.write(json.dumps(obj) + "\n")


def read_exactly(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def reply(conn, obj):
    body = json.dumps(obj).encode()
    prefix = struct.pack(">I", len(body)) if BIG_ENDIAN else struct.pack("=I", len(body))
    conn.sendall(prefix + body)


def handle(conn):
    with conn:
        head = read_exactly(conn, 4)
        if head is None:
            return
        # The client's own framing is always native-endian; --big-endian only
        # corrupts the REPLY, so a mismatch is attributable to one direction.
        (length,) = struct.unpack("=I", head)
        body = read_exactly(conn, length)
        if body is None:
            record({"error": "short body", "expected": length})
            return
        req = json.loads(body.decode())
        record(req)

        t = req.get("type")
        if t == "create_session":
            reply(conn, {"type": "auth_message",
                         "auth_message_type": "secret",
                         "auth_message": "Password:"})
        elif t == "post_auth_message_response":
            if req.get("response") == GOOD_PASSWORD:
                reply(conn, {"type": "success"})
            else:
                reply(conn, {"type": "error",
                             "error_type": "auth_error",
                             "description": "authentication failed"})
        elif t in ("start_session", "cancel_session"):
            reply(conn, {"type": "success"})
        else:
            reply(conn, {"type": "error", "error_type": "error",
                         "description": f"unknown request {t}"})


print(f"fake-greetd listening on {SOCK}"
      f"{' (replies BIG-ENDIAN — negative control)' if BIG_ENDIAN else ''}", flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
