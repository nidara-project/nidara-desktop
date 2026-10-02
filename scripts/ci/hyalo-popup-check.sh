#!/bin/sh
# hyalo-popup-check.sh — a menu of the dock on Hyalo (xdg_popup grab, shell/mod.rs `grab` and
# `popup_destroyed`). Real clicks, through the virtual pointer.
#
#   1. the keyboard is back in the field once a menu of the dock closes, without a click on the
#      field (the click that closes it goes to the dock's empty glass). Until 2026-10-02 it
#      stayed on the dock, and what was typed next went nowhere;
#   2. with an input method holding the keyboard, as fcitx5 does while a text field has the
#      focus, a click in ANOTHER app closes the menu, and the keyboard and the input method are
#      back in the field. Until then the input method's grab made Hyalo refuse the menu's, and
#      the menu stayed open with no grab at all.
#
# Each step was seen to FAIL on its own (2026-10-02): step 1 against the Hyalo before the fix,
# step 2 against one with only `popup_destroyed` fixed. Run INSIDE a Hyalo session (the Hyalo
# smoke; locally, a nested Hyalo — never against a live desktop: it clicks), with
# `hyalo-ime-probe` in PATH and no other input method running. Exits 1 on failure. MSG overrides
# `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${POPUP_LOG:-/tmp/hyalo-popup}
mkdir -p "$log"
: >"$log/menu.log"; : >"$log/field.log"; : >"$log/ime.log"
preload=$(ls /usr/lib/libgtk4-layer-shell.so* 2>/dev/null | head -1)
fail() { echo "FAIL: $*"; tail -n 20 "$log"/*.log; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT
# The number of lines saying $2 in $1's log.
count() { grep -c "^$2\$" "$log/$1.log" || true; }
# Waits up to 2 s for $1's log to say $2 more than $3 times.
wait_more() { for _ in $(seq 1 20); do [ "$(count "$1" "$2")" -gt "$3" ] && return 0; sleep 0.1; done; return 1; }
read_size() { "$here/../../bin/nidara-wm" monitors | jq -r '.[0] | "\(.width / .scale | floor) \(.height / .scale | floor)"'; }
click() { nidara-input "$1" "$2" "$3" "$W" "$H"; }

$MSG do workspace 1 >/dev/null
LD_PRELOAD="$preload" gjs -m "$here/hyalo-popup-probe.js" field >"$log/field.log" 2>&1 &
pids="$pids $!"
LD_PRELOAD="$preload" gjs -m "$here/hyalo-popup-probe.js" menu >"$log/menu.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do
    [ -n "$($MSG layers | jq -r '.ok.layers[] | select(.namespace == "popup-probe") | .x')" ] \
        && [ "$(count field "FIELD IN")" -gt 0 ] && break
    sleep 0.25
done
layer=$($MSG layers | jq -r '.ok.layers[] | select(.namespace == "popup-probe") | "\(.x) \(.y) \(.width) \(.height)"')
[ -n "$layer" ] || fail "the dock-shaped layer never appeared"
[ "$(count field "FIELD IN")" -gt 0 ] || fail "the field's window never had the keyboard"
set -- $(read_size); W=$1; H=$2
set -- $layer; LX=$1; LY=$2; LW=$3; LH=$4
icon_x=$((LX + 50)); icon_y=$((LY + LH / 2))         # the icon: the layer's left 100 px
glass_x=$((LX + LW - 30)); glass_y=$icon_y            # the empty glass beside it
read field_x field_y <<EOF
$($MSG windows | jq -r '.ok.windows[] | select(.title == "popup-field") | "\(.x + .width - 40) \(.y + .height - 40)"')
EOF
[ -n "$field_x" ] || fail "no popup-field window"

# 1. A menu closed by a click on the dock's own glass: the keyboard goes back to the field unasked.
opened=$(count menu "MENU OPEN"); closed=$(count menu "MENU CLOSED")
click rightclick "$icon_x" "$icon_y"
wait_more menu "MENU OPEN" "$opened" || fail "the right-click did not open the menu"
wait_more field "FIELD OUT" 0 || fail "the menu did not take the keyboard"
back=$(count field "FIELD IN")
sleep 0.5
click click "$glass_x" "$glass_y"
wait_more menu "MENU CLOSED" "$closed" || fail "a click on the dock's glass left the menu open"
wait_more field "FIELD IN" "$back" || fail "the menu closed and the keyboard did not go back to the field"
echo "ok    a menu of the dock closed and the keyboard went back to the field"

# 2. With an input method holding the keyboard, a click in another app closes the menu.
hyalo-ime-probe --hold >"$log/ime.log" 2>&1 &
pids="$pids $!"
wait_more ime GRABBED 0 || fail "the input method never took the keyboard from the field"
opened=$(count menu "MENU OPEN"); closed=$(count menu "MENU CLOSED")
click rightclick "$icon_x" "$icon_y"
wait_more menu "MENU OPEN" "$opened" || fail "the right-click did not open the menu (with the input method)"
sleep 0.5
back=$(count field "FIELD IN"); grabbed=$(count ime GRABBED)
click click "$field_x" "$field_y"
wait_more menu "MENU CLOSED" "$closed" \
    || fail "a click in another app left the menu open while an input method held the keyboard"
wait_more field "FIELD IN" "$back" || fail "the menu closed and the keyboard did not go back to the field (with the input method)"
wait_more ime GRABBED "$grabbed" || fail "the keyboard went back to the field but the input method did not take it"
echo "ok    with an input method holding the keyboard, a click in another app closed the menu; keyboard and input method back"
