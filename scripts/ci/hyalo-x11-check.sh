#!/bin/sh
# hyalo-x11-check.sh — X11 apps on Hyalo (hyalo/compositor/src/xwayland.rs): Hyalo starts
# Xwayland and is its window manager. Run INSIDE a Hyalo session started with HYALO_CONTROL (the
# Hyalo smoke; locally, a nested Hyalo), with jq and wl-clipboard in PATH.
#
#   1. an X11 client maps as a window of its own: its class as the app id, marked `xwayland`,
#      and ITS pid — not Xwayland's, which is Hyalo's child (a game is found by its process);
#   2. it takes the keyboard: keys typed after a click reach it (X's own input focus is set);
#   3. the clipboard both ways: what it copies, a Wayland client pastes; what a Wayland client
#      copies, it pastes (each checked against what was there before: the control);
#   4. an X11 menu (override-redirect) is drawn where its client put it, and keeps drawing: its
#      second frame (green) replaces its first (red) — without frame callbacks Xwayland never
#      commits it (Steam's menus stayed black, 2026-10-07).
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${X11_LOG:-/tmp/hyalo-x11}
mkdir -p "$log"
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*"; $MSG xwayland || true; tail -n 20 "$log"/*.log 2>/dev/null; exit 1; }
probe() { GDK_BACKEND=x11 gjs -m "$here/hyalo-x11-probe.js" "$@"; }
win() { $MSG windows | jq -c '.ok.windows[] | select(.app_id == "org.nidara.x11probe" and .width > 0)'; }

x=$($MSG xwayland)
[ "$(echo "$x" | jq -r '.ok.ready')" = "true" ] || fail "Xwayland is not up: $x"
DISPLAY=$(echo "$x" | jq -r '.ok.display')
export DISPLAY
echo "ok    Xwayland is up on $DISPLAY"

# 1. A window of its own, with its own pid.
# Started directly, not through `probe`: a function in the background is a subshell, and `$!`
# its pid.
GDK_BACKEND=x11 gjs -m "$here/hyalo-x11-probe.js" window >"$log/window.log" 2>&1 &
ppid=$!
pids="$pids $ppid"
for _ in $(seq 1 40); do [ -n "$(win)" ] && break; sleep 0.25; done
w=$(win)
[ -n "$w" ] || fail "the X11 window never appeared"
[ "$(echo "$w" | jq -r '.xwayland')" = "true" ] || fail "the window is not marked xwayland: $w"
[ "$(echo "$w" | jq -r '.pid')" = "$ppid" ] || fail "its pid is $(echo "$w" | jq -r '.pid'), not the probe's $ppid"
echo "ok    an X11 window, its class as app id, with its own pid ($ppid)"

# 2. The keyboard.
cx=$(echo "$w" | jq -r '.x + (.width / 2) | floor'); cy=$(echo "$w" | jq -r '.y + (.height / 2) | floor')
printf 'click %s %s\n' "$cx" "$cy" >"$C"; sleep 0.5
grep -q '^KEY a$' "$log/window.log" && fail "control: a key arrived before any was typed"
printf 'key 30\n' >"$C"; sleep 0.5   # evdev 30 = a
grep -q '^KEY a$' "$log/window.log" || fail "a key typed after a click did not reach the X11 window"
echo "ok    keys reach the X11 window"

# 3. The clipboard, both ways.
printf 'wayland-before' | wl-copy >/dev/null 2>&1; sleep 0.3
printf 'key 46\n' >"$C"; sleep 0.8  # c: the probe copies "from-x11"
got=$(timeout 3 wl-paste -n 2>/dev/null || true)
[ "$got" = "from-x11" ] || fail "a Wayland paste got '$got', not what the X11 window copied"
printf 'from-wayland' | wl-copy >/dev/null 2>&1; sleep 0.3
printf 'key 47\n' >"$C"; sleep 0.8  # v: the probe pastes
grep -q '^CLIP from-wayland$' "$log/window.log" || fail "the X11 window did not paste what a Wayland client copied"
echo "ok    the clipboard both ways (X11 → Wayland, Wayland → X11)"
kill "$ppid" 2>/dev/null || true

# 4. An override-redirect menu, and its second frame.
GDK_BACKEND=x11 gjs -m "$here/hyalo-x11-probe.js" popup >"$log/popup.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do grep -q GREEN "$log/popup.log" && break; sleep 0.25; done
grep -q GREEN "$log/popup.log" || fail "the popup never drew its second frame"
sleep 0.5
[ "$($MSG xwayland | jq -r '.ok.overrides')" -ge 1 ] || fail "Hyalo does not count the popup as an X11 menu"
$MSG screenshot "$log/popup.png" >/dev/null
origin=$($MSG outputs | jq -r '.ok.outputs[0].position | "\(.[0]) \(.[1])"')
set -- $origin
rgb=$(probe pixel "$log/popup.png" $((160 - $1)) $((140 - $2)) | sed -n 's/^RGB //p')
case "$rgb" in
    "0 255 0") echo "ok    an X11 menu is drawn where it was put, and its next frame shows" ;;
    "255 0 0") fail "the X11 menu is stuck on its first frame (no frame callbacks)" ;;
    *) fail "the X11 menu is not drawn at 100,100 (pixel $rgb)" ;;
esac
