#!/bin/sh
# hyalo-ime-check.sh — input methods on Hyalo (text-input-v3 + input-method-v2, handlers.rs):
# A focused window's empty field must get the stand-in input method's text, with
# the empty field before it as the control. Rust Prism/search is not implemented
# (#959); that old TS-specific half is explicitly removed, not silently skipped.
# Run only inside the isolated Hyalo smoke or a private nested compositor.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${IME_LOG:-/tmp/hyalo-ime}
mkdir -p "$log"
preload=$(ls /usr/lib/libgtk4-layer-shell.so* 2>/dev/null | head -1)
focused() { $MSG windows | jq -r '.ok.windows[] | select(.focused) | .title'; }
fail() { echo "FAIL: $*"; tail -n 20 "$log"/*.log 2>/dev/null; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT

$MSG do workspace 1 >/dev/null
LD_PRELOAD="$preload" gjs -m "$here/hyalo-lock-probe.js" victim >"$log/field.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do [ "$(focused)" = "lock-victim" ] && break; sleep 0.25; done
[ "$(focused)" = "lock-victim" ] || fail "the field's window never had the keyboard"
sleep 0.5
grep -q VICTIM "$log/field.log" && fail "control: the field had text before any input method ran"

hyalo-ime-probe "输入法" >"$log/ime1.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do grep -q "VICTIM 输入法" "$log/field.log" && break; sleep 0.25; done
grep -q "VICTIM 输入法" "$log/field.log" || fail "the window's field did not get the input method's text"
echo "ok    a window's field got the input method's text (and nothing before it ran)"

# Rust Prism/search is not ported (#959). The compositor/window IME check above
# remains mandatory; real toolkit fcitx5/Orca gates remain in hyalo-smoke.sh.
