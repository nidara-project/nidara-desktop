#!/bin/sh
# hyalo-inhibit-check.sh — keyboard-shortcuts-inhibit on Hyalo (hyalo/compositor/src/shortcuts.rs),
# with keys pressed through HYALO_CONTROL (the same path as a keyboard, bindings included). Run
# INSIDE a Hyalo session started with HYALO_CONTROL (the Hyalo smoke; locally, a nested Hyalo).
#
#   1. held: a focused window holds the shortcuts; Super+2 does NOT switch workspace;
#   2. given back: Super+Escape (a `dont_inhibit` binding) runs anyway and gives them back;
#   3. the control: Super+2 now switches — the keys and the binding work, so step 1 proved
#      the hold and not a dead key.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${INHIBIT_LOG:-/tmp/hyalo-inhibit.log}
ws() { $MSG workspaces | jq -r '.ok.workspaces[] | select(.focused) | .id'; }
fail() { echo "FAIL: $*"; cat "$log"; exit 1; }
# evdev codes: 125 Super, 1 Escape, 3 the "2" key.
# One write per chord: Hyalo reads the FIFO until EOF and opens it again, so separate writes
# race that reopen and the shell dies of SIGPIPE.
chord() { printf 'keydown 125\nkey %s\nkeyup 125\n' "$1" >"$C"; sleep 0.6; }

$MSG do workspace 1 >/dev/null
gjs -m "$here/hyalo-inhibit-probe.js" >"$log" 2>&1 &
probe=$!
trap 'kill $probe 2>/dev/null' EXIT
for _ in $(seq 1 40); do grep -q INHIBITED "$log" && break; sleep 0.25; done
grep -q INHIBITED "$log" || fail "the window was never granted the shortcuts"

chord 3
[ "$(ws)" = "1" ] || fail "held: Super+2 switched to workspace $(ws) while the focused app held the shortcuts"
echo "ok    held: Super+2 went to the app, not the desktop"

chord 1
grep -q RELEASED "$log" || fail "given back: Super+Escape did not take the shortcuts back"
echo "ok    given back: Super+Escape ran anyway"

chord 3
[ "$(ws)" = "2" ] || fail "control: Super+2 did not switch to workspace 2 once given back (on $(ws))"
echo "ok    control: with the shortcuts back, Super+2 switches"
$MSG do workspace 1 >/dev/null
