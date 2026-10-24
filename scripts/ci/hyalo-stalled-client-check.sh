#!/bin/bash
# hyalo-stalled-client-check.sh — a window that stops reading its socket for a while (busy on its
# own work) keeps its connection while the pointer moves over it, and gets every event once it
# reads again (state.rs, CLIENT_BUFFER). With wayland-backend's 4 KiB default the client was
# dropped, silently, after some 420 motions: the native Settings' Broken pipe (#915). Its proof
# of failing: the same run on Hyalo before CLIENT_BUFFER, DISCONNECTED (ECONNRESET) with 426 of
# 1500 motions read. Run INSIDE a Hyalo session started with HYALO_CONTROL, with
# `hyalo-stalled-client-probe` in PATH. Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${STALL_LOG:-/tmp/hyalo/stalled-client}
moves=${STALL_MOVES:-1500}
mkdir -p "$log"
fail() { echo "FAIL: $*"; cat "$log/probe.log"; exit 1; }
fifo="$log/release"
rm -f "$fifo"; mkfifo "$fifo"
hyalo-stalled-client-probe <"$fifo" >"$log/probe.log" 2>&1 &
probe=$!
exec 4>"$fifo"
trap 'exec 4>&- 2>/dev/null; kill $probe 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do grep -q STALLING "$log/probe.log" 2>/dev/null && break; sleep 0.1; done
grep -q STALLING "$log/probe.log" || fail "the probe did not map and stall"
read -r x y w h < <($MSG windows | jq -r '.ok.windows[] | select(.title=="stalled-client-probe") | "\(.x) \(.y) \(.width) \(.height)"')
[ -n "${h:-}" ] || fail "the probe's window is not listed"
cx=$((x + w / 2)); cy=$((y + h / 2))
# Back and forth across its middle: every move is a motion and a frame for the probe.
for i in $(seq 1 "$moves"); do
    echo "move $((cx - 100 + i % 200)) $cy"
    sleep 0.003
done >"$C"
sleep 1
echo go >&4
wait $probe || true
grep -q '^ALIVE' "$log/probe.log" || fail "a client that stopped reading for $moves pointer motions was dropped"
read_n=$(sed -n 's/^ALIVE motions_read=\([0-9]*\).*/\1/p' "$log/probe.log")
# Its window spans 400 px and the moves 200 around its middle: each one is a motion it must get.
[ "$read_n" -ge $((moves - 10)) ] || fail "kept, but only $read_n of $moves motions reached it"
echo "ok    a client that stopped reading kept its connection and got $read_n of $moves motions"
