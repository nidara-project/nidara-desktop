#!/bin/sh
# hyalo-idle-check.sh — idle on Hyalo (hyalo/compositor/src/idle.rs): with nobody at the keys the
# session locks and the screens go dark; the first key brings them back; a SHOWN window holding
# idle off (idle-inhibit, a video) keeps all of it away — and once it lets go, the lock comes
# (the control: the hold was the inhibitor, not a timer that never runs). Run INSIDE a Hyalo
# session started with HYALO_CONTROL and HYALO_LOCK_RELAUNCH (the lock check's: the idle lock
# starts that probe), with `hyalo-idle-inhibit-probe` in PATH.
#
# The screens going dark is checked only where they can (the tty backend: `powered`).
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
: "${HYALO_LOCK_RELAUNCH:?HYALO_LOCK_RELAUNCH is not set — Hyalo must be started with it pointing at the lock probe}"
log=${IDLE_LOG:-/tmp/hyalo-idle}
relaunched=${LOCK_RELAUNCHED_LOG:-/tmp/hyalo/lock/relaunched.log}
mkdir -p "$log"
locked() { $MSG lock | jq -r '.ok.locked'; }
powered() { $MSG outputs | jq -r '[.ok.outputs[] | select(.enabled != false) | .powered] | all'; }
tty=$($MSG outputs | jq -r '.ok.outputs[0].name != "winit"')
fail() { echo "FAIL: $*"; $MSG idle; tail -n 20 "$log"/*.log "$relaunched" 2>/dev/null; $MSG settings '{"idle":null}' >/dev/null; exit 1; }
# evdev 24 o, 37 k: the lock probe unlocks on "ok" (hyalo-lock-probe.js).
wait_locked() { for _ in $(seq 1 "$1"); do [ "$(locked)" = "true" ] && return 0; sleep 0.5; done; return 1; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT

$MSG settings '{"idle":{"screen_off":2,"lock":3,"suspend":0}}' >/dev/null
: >"$relaunched"
wait_locked 14 || fail "idle: three seconds without input did not lock the session"
if [ "$tty" = "true" ]; then
    [ "$(powered)" = "false" ] || fail "idle: the screens stayed on"
    echo "ok    idle: locked, and the screens went dark"
else
    echo "ok    idle: locked (no screens to darken in a window)"
fi
for _ in $(seq 1 20); do grep -q LOCKED "$relaunched" 2>/dev/null && break; sleep 0.25; done
printf 'key 24\nkey 37\n' >"$C"; sleep 1
[ "$tty" != "true" ] || [ "$(powered)" = "true" ] || fail "a key did not bring the screens back"
[ "$(locked)" = "false" ] || fail "the first keys did not reach the lock screen (still locked)"
echo "ok    the first key woke the screens and reached the lock screen"

hyalo-idle-inhibit-probe 7 >"$log/inhibit.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 20); do grep -q INHIBITING "$log/inhibit.log" && break; sleep 0.25; done
grep -q INHIBITING "$log/inhibit.log" || fail "the inhibiting window never started"
sleep 5
[ "$(locked)" = "false" ] || fail "inhibited: the session locked while a shown window held idle off"
[ "$($MSG idle | jq -r '.ok.inhibited')" = "true" ] || fail "inhibited: Hyalo does not say idle is held"
echo "ok    inhibited: five seconds idle with a window holding it off, and nothing happened"

for _ in $(seq 1 12); do grep -q RELEASED "$log/inhibit.log" && break; sleep 0.25; done
: >"$relaunched"
wait_locked 14 || fail "control: once the window let go, idle did not lock"
echo "ok    control: once the window let go, the session locked"
for _ in $(seq 1 20); do grep -q LOCKED "$relaunched" 2>/dev/null && break; sleep 0.25; done
printf 'key 24\nkey 37\n' >"$C"; sleep 1
[ "$(locked)" = "false" ] || fail "could not unlock after the control"
$MSG settings '{"idle":null}' >/dev/null
