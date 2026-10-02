#!/bin/sh
# hyalo-lock-check.sh — the lock screen on Hyalo (ext-session-lock-v1, hyalo/compositor/src/lock.rs),
# keys through HYALO_CONTROL (the same path as a keyboard, bindings included). Run INSIDE a Hyalo
# session started with HYALO_CONTROL (the Hyalo smoke; locally, a nested Hyalo).
#
#   1. locked: the client hears `locked`, and Hyalo says so (`msg lock`) with a lock surface;
#   2. keys go to the lock screen and not to the window that had the keyboard;
#   3. the desktop's bindings do not run (Super+2 does not switch workspace);
#   4. a second lock request is refused while the first client holds the lock;
#   5. the lock client dies: the session STAYS locked, and Hyalo starts the lock client again,
#      which takes the lock over (HYALO_LOCK_RELAUNCH, set where Hyalo is started, runs this
#      probe into $LOCK_LOG/relaunched.log);
#   6. unlocked: the keyboard is back in the window, which now gets the keys — the control,
#      so step 2 proved the lock and not keys that reached nobody.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
: "${HYALO_LOCK_RELAUNCH:?HYALO_LOCK_RELAUNCH is not set — Hyalo must be started with it pointing at the probe}"
log=${LOCK_LOG:-/tmp/hyalo-lock}
mkdir -p "$log"
preload=$(ls /usr/lib/libgtk4-layer-shell.so* 2>/dev/null | head -1)
probe() { LD_PRELOAD="$preload" gjs -m "$here/hyalo-lock-probe.js" "$1" >"$log/$2.log" 2>&1 & echo $!; }
locked() { $MSG lock | jq -r '.ok.locked'; }
ws() { $MSG workspaces | jq -r '.ok.workspaces[] | select(.focused) | .id'; }
focused() { $MSG windows | jq -r '.ok.windows[] | select(.focused) | .title'; }
wait_for() { for _ in $(seq 1 40); do grep -q "$1" "$log/$2.log" && return 0; sleep 0.25; done; return 1; }
fail() { echo "FAIL: $*"; tail -n 20 "$log"/*.log; exit 1; }
# evdev codes: 24 o, 37 k, 30 a, 125 Super, 3 the "2" key. One write per sequence (see
# hyalo-inhibit-check.sh: separate writes race the FIFO's reopen).
keys() { printf "$1" >"$C"; sleep 0.6; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT

$MSG do workspace 1 >/dev/null
victim=$(probe victim victim); pids="$pids $victim"
for _ in $(seq 1 40); do [ "$(focused)" = "lock-victim" ] && break; sleep 0.25; done
[ "$(focused)" = "lock-victim" ] || fail "the victim window never had the keyboard (on '$(focused)')"

first=$(probe lock lock1); pids="$pids $first"
wait_for LOCKED lock1 || fail "the lock client never heard 'locked'"
[ "$(locked)" = "true" ] || fail "Hyalo does not say the session is locked"
[ -n "$($MSG lock | jq -r '.ok.surfaces[0] // empty')" ] || fail "no output has a lock surface"
echo "ok    locked: the client heard it, Hyalo says it, an output has the lock surface"

keys 'key 30\n'
wait_for "TYPED a" lock1 || fail "a key typed while locked did not reach the lock screen"
grep -q "VICTIM" "$log/victim.log" && fail "a key typed while locked reached the window behind the lock"
echo "ok    keys: to the lock screen, not to the window that had the keyboard"

keys 'keydown 125\nkey 3\nkeyup 125\n'
[ "$(ws)" = "1" ] || fail "Super+2 switched to workspace $(ws) while locked"
echo "ok    bindings: Super+2 did nothing while locked"

second=$(probe lock lock2); pids="$pids $second"
wait_for FAILED lock2 || fail "a second lock request was not refused while the first client holds the lock"
echo "ok    a second locker is refused while the first holds the lock"

kill -9 "$first"
sleep 0.5
[ "$(locked)" = "true" ] || fail "the session was unlocked when the lock client died"
for _ in $(seq 1 8); do wait_for LOCKED relaunched 2>/dev/null && break; done
wait_for LOCKED relaunched || fail "Hyalo did not start the lock client again, or it could not take the lock over"
echo "ok    the lock client died: the session stayed locked, and Hyalo started it again"

keys 'key 24\nkey 37\n'
wait_for UNLOCKED relaunched || fail "the lock client could not unlock"
sleep 0.5
[ "$(locked)" = "false" ] || fail "Hyalo still says the session is locked after the unlock"
[ "$(focused)" = "lock-victim" ] || fail "after the unlock the keyboard is not back in the window (on '$(focused)')"
keys 'key 30\n'
wait_for "VICTIM a" victim || fail "control: after the unlock the window does not get the keys"
echo "ok    unlocked: the keyboard is back in the window, and it gets the keys (the control)"
