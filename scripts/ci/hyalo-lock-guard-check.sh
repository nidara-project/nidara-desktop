#!/bin/sh
# hyalo-lock-guard-check.sh — the guard (hyalo/compositor/src/lock.rs): when Hyalo wants the
# session locked and the lock client it starts never asks for the lock, Hyalo locks the session
# ITSELF, and a lock client can still take it over and unlock. Before sleep that is the
# difference between a machine that comes back locked and one that comes back open (logind.rs);
# sleep cannot be had in a container, so the idle lock asks here — the same `lock_session`.
#
#   1. a lock client that does not start: the session is locked anyway (`guard`), and keys do
#      not reach the window that had the keyboard;
#   2. a lock client that starts: a key press brings it back, it takes the guarded session
#      over (a relock), and unlocks it — the keyboard is back in the window;
#   3. a lock client that connects and hangs before asking: locked anyway, and again a working
#      one takes it over;
#   4. the control: after that unlock the window gets the keys, so step 1 proved the guard and
#      not keys that reached nobody.
#
# Run INSIDE a Hyalo session started with HYALO_CONTROL and HYALO_LOCK_RELAUNCH pointing at
# hyalo-lock-client.sh (the Hyalo smoke). Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
: "${HYALO_LOCK_RELAUNCH:?HYALO_LOCK_RELAUNCH is not set — Hyalo must be started with it pointing at hyalo-lock-client.sh}"
d=${LOCK_LOG:-/tmp/hyalo/lock}
log=${GUARD_LOG:-/tmp/hyalo-guard}
mkdir -p "$log" "$d"
preload=$(ls /usr/lib/libgtk4-layer-shell.so* 2>/dev/null | head -1)
lockq() { $MSG lock | jq -r ".ok.$1"; }
focused() { $MSG windows | jq -r '.ok.windows[] | select(.focused) | .title'; }
mode() { echo "$1" >"$d/client-mode"; }
cleanup() {
    kill $pids 2>/dev/null || true
    pkill -f 'hyalo-lock-probe.js hang' 2>/dev/null || true
    mode lock
    $MSG settings '{"idle":null}' >/dev/null 2>&1 || true
}
fail() { echo "FAIL: $*"; $MSG lock; tail -n 20 "$log"/*.log "$d"/relaunched*.log 2>/dev/null; cleanup; exit 1; }
# evdev codes: 30 a, 24 o, 37 k (the lock probe unlocks on "ok"), 42 Shift — what brings the lock
# client back: a key that types nothing into it once it is up. One write per sequence.
keys() { printf "$1" >"$C"; sleep 0.6; }
pids=""
trap cleanup EXIT

# Idle locks after 2 s; the guard comes GUARD_AFTER (5 s) after that.
wait_guard() { for _ in $(seq 1 30); do [ "$(lockq guard)" = "true" ] && return 0; sleep 0.5; done; return 1; }
idle_lock() { $MSG settings '{"idle":{"screen_off":0,"lock":2,"suspend":0}}' >/dev/null; }
idle_off() { $MSG settings '{"idle":null}' >/dev/null; }
# From the guard: a working lock client, brought back by a key press, takes the session over
# and unlocks it.
take_over() {
    mode lock
    : >"$d/relaunched.log"
    sleep 2.5 # Hyalo starts at most one lock client per 2 s (lock.rs: relaunch_lock)
    keys 'key 42\n'
    for _ in $(seq 1 40); do grep -q '^LOCKED' "$d/relaunched.log" 2>/dev/null && break; sleep 0.25; done
    grep -q '^LOCKED' "$d/relaunched.log" || fail "$1: no lock client took the guarded session over"
    [ "$(lockq guard)" = "false" ] || fail "$1: a lock client holds the lock, and Hyalo still says it guards"
    [ "$(lockq locked)" = "true" ] || fail "$1: the session is not locked under the lock client that took it over"
    for _ in $(seq 1 20); do [ -n "$($MSG lock | jq -r '.ok.surfaces[0] // empty')" ] && break; sleep 0.25; done
    keys 'key 24\nkey 37\n'
    for _ in $(seq 1 20); do grep -q UNLOCKED "$d/relaunched.log" && break; sleep 0.25; done
    grep -q UNLOCKED "$d/relaunched.log" || fail "$1: the lock client that took over could not unlock"
    sleep 0.5
    [ "$(lockq locked)" = "false" ] || fail "$1: still locked after the unlock"
    for _ in $(seq 1 20); do [ "$(focused)" = "lock-victim" ] && break; sleep 0.25; done
    [ "$(focused)" = "lock-victim" ] || fail "$1: after the unlock the keyboard is not back in the window (on '$(focused)')"
}

$MSG do workspace 1 >/dev/null
LD_PRELOAD="$preload" gjs -m "$here/hyalo-lock-probe.js" victim >"$log/victim.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do [ "$(focused)" = "lock-victim" ] && break; sleep 0.25; done
[ "$(focused)" = "lock-victim" ] || fail "the victim window never had the keyboard (on '$(focused)')"

# 1. a lock client that does not start
mode none
: >"$d/relaunched-none.log"
idle_lock
wait_guard || fail "no lock client started, and the session was never locked: Hyalo did not guard it"
idle_off
[ "$(lockq locked)" = "true" ] || fail "Hyalo guards and does not say the session is locked"
grep -q 'NOT STARTED' "$d/relaunched-none.log" || fail "the lock client that does not start was never asked for (not the case under test)"
keys 'key 30\n'
grep -q 'VICTIM' "$log/victim.log" && fail "a key typed while guarded reached the window behind it"
echo "ok    a lock client that does not start: Hyalo locked the session itself, keys reach nobody"

# 2. taken over and unlocked
take_over "after a client that did not start"
echo "ok    a working lock client took the guarded session over, and unlocked it"

# 3. a lock client that hangs before asking
mode hang
: >"$d/relaunched-hang.log"
idle_lock
wait_guard || fail "the lock client hung before asking, and the session was never locked: Hyalo did not guard it"
idle_off
grep -q '^HANGING' "$d/relaunched-hang.log" || fail "the hanging lock client never connected (not the case under test)"
# The hung client stays: one stuck before its request must not keep a working one out.
take_over "after a client that hung"
pkill -f 'hyalo-lock-probe.js hang' || true
echo "ok    a lock client that hangs before asking: locked by Hyalo, then taken over and unlocked"

# 4. the control
keys 'key 30\n'
for _ in $(seq 1 20); do grep -q 'VICTIM a' "$log/victim.log" && break; sleep 0.25; done
grep -q 'VICTIM a' "$log/victim.log" || fail "control: after the unlock the window does not get the keys"
echo "ok    control: after the unlock the window gets the keys"
