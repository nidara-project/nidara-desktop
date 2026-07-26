#!/usr/bin/env python3
"""Timestamped tap on Hyprland's event socket — the instrument for ordering bugs.

A whole class of shell bugs is not "what happened" but "in which order": our
dispatch versus the compositor's own reaction to something we did. Guessing at
that wastes hours; this prints both sides on one clock.

    scripts/dev/hypr-trace.py            # follow live
    scripts/dev/hypr-trace.py > t.log    # record a reproduction

Timestamps are `Date.now() % 100000`, the same clock a `console.log` from the
shell lands on, so a shell log and a trace can be zipped together line by line:
add `console.log(\\`[X] ${Date.now() % 100000} …\\`)` at the moment of interest,
reproduce, then read the two files side by side. That is exactly how the
workspace-overview jump-back was pinned to layer-shell's double-buffered
keyboard interactivity (see `HyprlandState.focusWorkspaceOnGrabRelease`).

Pass event name prefixes to narrow the stream; default is the focus/workspace
set. `--all` keeps everything.
"""
import os
import socket
import sys
import time

DEFAULT_KEEP = (
    "workspace", "workspacev2", "activewindow", "activewindowv2",
    "focusedmon", "openlayer", "closelayer",
    "createworkspace", "destroyworkspace",
)

args = [a for a in sys.argv[1:] if not a.startswith("-")]
keep = None if "--all" in sys.argv else tuple(args) or DEFAULT_KEEP

try:
    sig = os.environ["HYPRLAND_INSTANCE_SIGNATURE"]
    runtime = os.environ["XDG_RUNTIME_DIR"]
except KeyError:
    sys.exit("not inside a Hyprland session (no HYPRLAND_INSTANCE_SIGNATURE)")

path = f"{runtime}/hypr/{sig}/.socket2.sock"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(path)
print(f"# {path}  (filter: {'all' if keep is None else ' '.join(keep)})", flush=True)

buf = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        txt = line.decode(errors="replace")
        name = txt.split(">>")[0]
        if keep is None or name in keep:
            print(f"{int(time.time() * 1000) % 100000}  {txt}", flush=True)
