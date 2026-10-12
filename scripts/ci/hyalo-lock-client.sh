#!/bin/sh
# hyalo-lock-client.sh — the lock client Hyalo starts in the smoke (HYALO_LOCK_RELAUNCH), in place
# of nidara-lock. Which one is up to the check that runs: $LOCK_LOG/client-mode says
#   lock   (or no file) the lock probe, which locks — into relaunched.log, as before
#   none   nothing starts: a lock client that fails before it reaches the compositor
#   hang   the probe connects and never asks for the lock
# so hyalo-lock-guard-check.sh can hand Hyalo a lock client that never locks.
here=$(dirname "$(realpath "$0")")
d=${LOCK_LOG:-/tmp/hyalo/lock}
mode=$(cat "$d/client-mode" 2>/dev/null || echo lock)
case "$mode" in
    none) echo "NOT STARTED" >>"$d/relaunched-none.log"; exit 1 ;;
    hang) LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so exec gjs -m "$here/hyalo-lock-probe.js" hang >>"$d/relaunched-hang.log" 2>&1 ;;
    *) LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so exec gjs -m "$here/hyalo-lock-probe.js" lock >"$d/relaunched.log" 2>&1 ;;
esac
