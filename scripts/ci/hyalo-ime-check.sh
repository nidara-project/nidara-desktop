#!/bin/sh
# hyalo-ime-check.sh — input methods on Hyalo (text-input-v3 + input-method-v2, handlers.rs):
# what fcitx5 types reaches a window, AND the shell's search while it holds the keyboard through a
# focus grab — which Hyprland never managed (#679 #10, #503: no Chinese in our search). The
# stand-in input method commits a fixed string when a field is activated (hyalo-ime-probe.c).
#
#   1. a focused window's empty field gets the input method's text — no key was pressed, so it
#      can only have come through the input method (the control is the empty field before);
#   2. the shell's search (a layer surface under a focus grab) gets it too.
#
# Run INSIDE a Hyalo session with the shell (the Hyalo smoke; locally, a nested Hyalo), with
# `hyalo-ime-probe` in PATH. Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
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

if command -v nidara-ipc >/dev/null && nidara-ipc toggleSearch >/dev/null 2>&1; then
    sleep 1.5
    hyalo-ime-probe "搜索" >"$log/ime2.log" 2>&1 &
    pids="$pids $!"
    for _ in $(seq 1 40); do nidara-ipc queryUI .prism-search-entry 2>/dev/null | grep -q '"text": "搜索"' && break; sleep 0.25; done
    nidara-ipc queryUI .prism-search-entry 2>/dev/null | grep -q '"text": "搜索"' \
        || fail "the shell's search, under its focus grab, did not get the input method's text"
    nidara-ipc toggleSearch >/dev/null 2>&1 || true
    echo "ok    the shell's search under its focus grab got it too (#503)"
else
    echo "skip  the shell's search: no shell to ask (nidara-ipc)"
fi
