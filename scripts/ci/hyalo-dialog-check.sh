#!/bin/sh
# hyalo-dialog-check.sh — a modal dialog keeps the focus from its parent on Hyalo (xdg-dialog-v1,
# wm::focus_window). Run INSIDE a Hyalo session (the Hyalo smoke; locally, a nested Hyalo).
#
#   1. modal: focusing the parent gives the focus to its modal dialog;
#   2. the control: with a dialog that is NOT modal, focusing the parent focuses the parent —
#      so step 1 proved the modal rule, not a focus request that did nothing.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${DIALOG_LOG:-/tmp/hyalo-dialog.log}
id() { $MSG windows | jq -r --arg t "$1" '.ok.windows[] | select(.title == $t and .width > 0) | .id'; }
focused() { $MSG windows | jq -r '.ok.windows[] | select(.focused) | .title'; }
fail() { echo "FAIL: $*"; cat "$log"; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null' EXIT

for mode in modal plain; do
    gjs -m "$here/hyalo-dialog-probe.js" "$mode" >>"$log" 2>&1 &
    pids="$pids $!"
    for _ in $(seq 1 40); do [ -n "$(id "dlg-$mode")" ] && break; sleep 0.25; done
    [ -n "$(id "dlg-$mode")" ] || fail "the $mode dialog never appeared"
    sleep 0.3
    $MSG do focus-window "$(id "dlg-parent-$mode")" >/dev/null
    sleep 0.3
    case $mode in
        modal) [ "$(focused)" = "dlg-modal" ] || fail "modal: focusing the parent took the focus from its modal dialog (on $(focused))"
               echo "ok    modal: the parent gave way to its modal dialog" ;;
        plain) [ "$(focused)" = "dlg-parent-plain" ] || fail "control: a dialog that is not modal kept the focus from its parent (on $(focused))"
               echo "ok    control: with a dialog that is not modal, the parent takes the focus" ;;
    esac
done
