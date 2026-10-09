#!/bin/sh
# hyalo-window-controls-check.sh — a window's controls are Hyalo's (#708 point 5,
# hyalo/compositor/src/protocols/window_controls.rs): the app leaves room for them, Hyalo draws
# them there and takes their clicks; only the buttons that do something are drawn. Run INSIDE a
# Hyalo session started with HYALO_CONTROL, with `hyalo-window-controls-probe` in PATH.
#
#   1. the probe is told the box (88×32: minimize, maximize and close) and the side (right),
#      and Hyalo reports the controls where the probe placed them;
#   2. the pointer over the window reaches the app, over its controls it does not (the app
#      gets a leave);
#   3. maximize maximizes and restores; the app sees no click;
#   4. the side switched to left in the settings layer: the probe is told, places the box on
#      the left, and Hyalo reports it there; then back to the right;
#   5. the buttons: the user's choice of close alone (the settings layer) gives a 32 px box;
#      the app asking for close alone (set_buttons) too; asking for all again while it cannot
#      change size, minimize and close (60); resizable again, maximize comes back;
#   5b. the ink: white glyphs over the probe's dark window; the app asks for dark ink
#      (set_ink) and the brightest pixel of its controls falls below its own window's grey;
#      asked again, light again;
#   6. a rule's `controls = ["close"]` gives a new window of the app a 32 px box;
#   7. close closes: the probe gets xdg_toplevel.close.
# The controls: the same probe against a Hyalo without the protocol prints NO_CONTROLS (step 1);
# against one that shows no minimize (before #724), the first layout is 60 wide (step 1);
# against one that ignores set_buttons, step 5 waits for a 32 px box that never comes.
# Minimizing itself is hyalo-minimize-check.sh.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${CONTROLS_LOG:-/tmp/hyalo-window-controls}
mkdir -p "$log"
out="$log/probe.log"
fail() { echo "FAIL: $*"; cat "$out" 2>/dev/null; $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-window-controls-probe")' 2>/dev/null; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null || true; $MSG settings "{\"windows\":null,\"rules\":null}" >/dev/null 2>&1 || true' EXIT
win() { $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-window-controls-probe")'; }
# A point in the controls: a fraction of their width, their middle. Three buttons: minimize in
# the first third, maximize in the second, close in the last.
at() { win | jq -r --argjson f "$1" '.controls | "\(.[0] + .[2] * $f) \(.[1] + .[3] / 2)"'; }
wait_line() { for _ in $(seq 1 40); do grep -q "$1" "$out" && return 0; sleep 0.25; done; return 1; }

hyalo-window-controls-probe >"$out" 2>&1 &
pid=$!; pids="$pids $pid"
wait_line '^PLACED' || fail "the probe never placed its box"
sleep 0.5

# 1. The box and the side; the controls where the probe put them.
last_layout() { grep '^LAYOUT' "$out" | tail -n 1; }
wait_layout() { for _ in $(seq 1 20); do [ "$(last_layout)" = "LAYOUT $1" ] && return 0; sleep 0.25; done; return 1; }
wait_layout 'right 88 32' || fail "the first layout is '$(last_layout)', not 'LAYOUT right 88 32'"
sleep 0.4
w=$(win)
[ -n "$w" ] || fail "the probe's window is not listed"
want=$(echo "$w" | jq -r '"\(.x + 400 - 12 - 88) \(.y + 12) 88 32"')
got=$(echo "$w" | jq -r '.controls | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "controls at '$got', the probe placed them at '$want'"
echo "ok    the box (88×32, right: minimize, maximize and close) is told, and the controls are where the app placed them"

# 2. The pointer: the app's over its body, Hyalo's over the controls.
echo "$w" | jq -r '"move \(.x + 40) \(.y + 150)"' >"$C"; sleep 0.4
grep -q '^POINTER enter' "$out" || fail "the pointer over the window's body never reached the app"
echo "move $(at 0.75)" >"$C"; sleep 0.4
[ "$(grep '^POINTER' "$out" | tail -n 1)" = "POINTER leave" ] || fail "over the controls, the app still has the pointer"
echo "ok    the pointer reaches the app, and not over its controls"

# 3. Maximize, and back.
echo "click $(at 0.5)" >"$C"; sleep 0.8
[ "$(win | jq -r .fullscreen)" = "maximized" ] || fail "maximize did not maximize: $(win | jq -c '{fullscreen}')"
grep -q '^BUTTON' "$out" && fail "the app got a click meant for the controls"
echo "click $(at 0.5)" >"$C"; sleep 0.8
[ "$(win | jq -r .fullscreen)" = "none" ] || fail "maximize again did not restore"
echo "ok    maximize maximizes and restores; the app saw no click"

# 4. The left side, live, and back.
$MSG settings '{"windows":{"controls":{"side":"left"}}}' >/dev/null
wait_layout 'left 88 32' || fail "the side changed and the app was not told: '$(last_layout)'"
sleep 0.5
w=$(win)
want=$(echo "$w" | jq -r '"\(.x + 12) \(.y + 12)"')
got=$(echo "$w" | jq -r '.controls[0:2] | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "on the left, controls at '$got', placed at '$want'"
$MSG settings '{"windows":null}' >/dev/null
wait_layout 'right 88 32' || fail "back to the right, the app was not told: '$(last_layout)'"
sleep 0.5
echo "ok    the side switched live: the app is told, and the controls follow"

# 5. Which buttons: the user's, the app's, what the window can do.
width() { win | jq -r '.controls[2] | floor'; }
$MSG settings '{"windows":{"controls":{"buttons":["close"]}}}' >/dev/null
wait_layout 'right 32 32' || fail "the user chose close alone, and the app was told '$(last_layout)'"
sleep 0.4; [ "$(width)" = 32 ] || fail "the user chose close alone, and the controls are $(width) wide"
$MSG settings '{"windows":null}' >/dev/null
wait_layout 'right 88 32' || fail "the user's buttons back, and the app was told '$(last_layout)'"
kill -USR1 "$pid"
wait_layout 'right 32 32' || fail "the app asked for close alone, and was told '$(last_layout)'"
sleep 0.4; [ "$(width)" = 32 ] || fail "the app asked for close alone, and the controls are $(width) wide"
kill -USR2 "$pid"
wait_line '^ASKED 12' || fail "the probe did not ask again"
sleep 0.6
[ "$(last_layout)" = "LAYOUT right 60 32" ] || fail "every button asked, but it cannot change size: told '$(last_layout)', not minimize and close"
kill -HUP "$pid"
wait_layout 'right 88 32' || fail "it can change size again, and was told '$(last_layout)'"
echo "ok    close alone when the user chooses it, when the app asks for it, and maximize only while it can change size"

# 5b. The ink. The brightest and the darkest pixel inside the controls, from a raw PPM (P6:
# "P6\nW H\n255\n", then RGB; read with od — GdkPixbuf's loaders run in a bwrap sandbox that a
# CI container refuses). The probe's window is 0x404040: white glyphs read well above it, dark
# ones leave nothing above it.
span() {
    $MSG screenshot "$log/ink.ppm" >/dev/null
    origin=$($MSG outputs | jq -r '.ok.outputs[0].position | "\(.[0]) \(.[1])"')
    box=$(win | jq -r '.controls | map(floor) | join(" ")')
    width=$(head -n 2 "$log/ink.ppm" | tail -n 1 | cut -d' ' -f1)
    header=$(head -n 3 "$log/ink.ppm" | wc -c)
    od -An -v -tu1 -j "$header" "$log/ink.ppm" | tr -s ' ' '\n' | grep -v '^$' | awk \
        -v W="$width" -v O="$origin" -v B="$box" 'BEGIN { split(O, o, " "); split(B, b, " ");
            x0 = b[1] - o[1] + 2; y0 = b[2] - o[2] + 2; x1 = x0 + b[3] - 4; y1 = y0 + b[4] - 4; lo = 999; hi = -1 }
        { i = int((NR - 1) / 3); c = (NR - 1) % 3; s += $1
          if (c == 2) { x = i % W; y = int(i / W)
            if (x >= x0 && x < x1 && y >= y0 && y < y1) { v = s / 3; if (v < lo) lo = v; if (v > hi) hi = v }
            s = 0 } }
        END { printf "%d %d\n", lo, hi }'
}
# The pointer on maximize: its glyph at full strength, whether the window has the focus or not.
echo "move $(at 0.5)" >"$C"; sleep 0.4
set -- $(span)
[ "$2" -gt 150 ] || fail "light ink: the brightest pixel of the controls is $2, white glyphs should read well above the window's 64"
kill -WINCH "$pid"
wait_line '^ASKED 28' || fail "the probe did not ask for dark ink"
sleep 0.6
set -- $(span)
[ "$2" -le 70 ] && [ "$1" -lt 40 ] || fail "dark ink asked, and the controls span $1..$2 (want nothing much above the window's 64, and dark glyphs below 40)"
kill -WINCH "$pid"
sleep 0.6
set -- $(span)
[ "$2" -gt 150 ] || fail "light ink again, and the brightest pixel is $2"
echo "ok    the app sets the controls' ink: white over its dark header, dark when it asks"

# 6. A rule: a new window of the app gets close alone.
kill $pid 2>/dev/null; sleep 0.4
$MSG settings '{"rules":{"probe-close-only":{"match":{"app_id":"^hyalo-window-controls-probe$"},"controls":["close"]}}}' >/dev/null
: >"$out"
hyalo-window-controls-probe >"$out" 2>&1 &
pid=$!; pids="$pids $pid"
wait_line '^PLACED' || fail "the second probe never placed its box"
wait_layout 'right 32 32' || fail "a rule's controls = [\"close\"], and the app was told '$(last_layout)'"
$MSG settings '{"rules":null}' >/dev/null
echo "ok    a rule's controls = [\"close\"] gives the app's window close alone"

# 7. Close.
sleep 0.5
echo "click $(at 0.5)" >"$C"
wait_line '^CLOSED' || fail "close did not ask the window to close"
echo "ok    close asks the window to close"
