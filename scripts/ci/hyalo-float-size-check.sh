#!/bin/sh
# First float after being born tiled (#809), and an already-owned floating box (#742).
# Run only INSIDE a test Hyalo, with its HYALO_CONTROL and the controls probe in PATH.
# The opt-in probe obeys nonzero configure sizes and chooses its natural size for 0x0.
# Controls seen failing: unchanged main cb405718 (tile size restored, no 0x0 configure).
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${FLOAT_SIZE_LOG:-/tmp/hyalo-float-size}
mkdir -p "$log"
C=${HYALO_CONTROL:?test compositor input required}
pid=""; failures=0
original=$($MSG workspaces | jq -r '.ok.workspaces[] | select(.focused) | .id' | head -n 1)
cleanup() {
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    $MSG do workspace "${original:-1}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; failures=$((failures+1)); }
win() { $MSG windows | jq -c --argjson pid "$pid" '.ok.windows[] | select(.pid == $pid)'; }
box() { win | jq -c '[.x,.y,.width,.height]'; }
act() { $MSG do "$@" >/dev/null; sleep 0.25; }
stop() { kill "$pid"; wait "$pid" 2>/dev/null || true; pid=""; sleep 0.25; }
open_probe() {
    kind=$1; out="$log/$2.log"
    if [ "$kind" = wayland ]; then
        HYALO_PROBE_CHOOSE_SIZE=1 hyalo-window-controls-probe >"$out" 2>&1 &
    else
        GDK_BACKEND=x11 gjs -m "$here/hyalo-x11-probe.js" window >"$out" 2>&1 &
    fi
    pid=$!
    for _ in $(seq 1 100); do [ -n "$(win)" ] && break; sleep 0.05; done
    [ -n "$(win)" ] || { echo "FAIL: $kind never mapped"; cat "$out"; exit 1; }
    sleep 0.3
    id=$(win | jq -r .id)
}
# Wait for the client's response, not only the WM's synchronous target box.
expect_box() {
    expected=$1; label=$2
    for _ in $(seq 1 50); do
        got=$(box)
        [ "$got" = "$expected" ] && break
        sleep 0.05
    done
    if [ "$got" = "$expected" ]; then echo "ok    $label: $got";
    else fail "$label expected=$expected got=$got"; fi
}
act workspace 91
act set-workspace-mode 91 floating
open_probe wayland natural
natural=$(box)
echo "baseline Wayland $natural"
stop
act set-workspace-mode 91 tiling
open_probe wayland float
[ "$(box)" != "$natural" ] || fail "Wayland probe did not obey its initial tiled configure"
act float "$id"
expect_box "$natural" "Wayland first float, natural and centred"
grep -q '^CONFIGURE 0 0$' "$out" || fail "Wayland first float never received configure 0x0"
stop
open_probe wayland move
act set-workspace-mode 92 floating
act move-to-workspace 92 "$id"
expect_box "$natural" "Wayland first float by workspace move"
grep -q '^CONFIGURE 0 0$' "$out" || fail "Wayland workspace move never received configure 0x0"
stop
# The same first float through toggle-floating.
act workspace 91
act set-workspace-mode 91 tiling
open_probe wayland toggle
act toggle-floating "$id"
expect_box "$natural" "Wayland first float by toggle"
stop
# Real pointer move before tiling: preserve the whole owned box in both workspace modes.
for mode in floating tiling; do
    act set-workspace-mode 91 floating
    open_probe wayland "return-$mode"
    act set-workspace-mode 91 "$mode"
    act float "$id"
    before=$(box)
    x=$(win | jq '.x+40'); y=$(win | jq '.y+80')
    printf 'press %s %s 272\n' "$x" "$y" >"$C"; sleep 0.2
    printf 'move %s %s\n' "$((x+50))" "$((y+30))" >"$C"; sleep 0.2
    printf 'release 272\n' >"$C"; sleep 0.3
    moved=$(box)
    [ "$moved" != "$before" ] || fail "$mode regression drag never moved the window"
    act tile "$id"; act float "$id"
    expect_box "$moved" "last floating box preserved ($mode)"
    stop
done
x11=$($MSG xwayland)
[ "$(echo "$x11" | jq -r '.ok.ready')" = true ] || { echo "FAIL: Xwayland not ready"; exit 1; }
DISPLAY=$(echo "$x11" | jq -r '.ok.display'); export DISPLAY
act set-workspace-mode 91 floating
open_probe x11 x11-natural
natural_x=$(box)
echo "baseline X11 $natural_x"
stop
act set-workspace-mode 91 tiling
open_probe x11 x11-float
[ "$(box)" != "$natural_x" ] || fail "X11 probe did not obey its initial tiled configure"
act float "$id"
expect_box "$natural_x" "X11 first float restores requested size, centred"
stop
open_probe x11 x11-move
act set-workspace-mode 92 floating
act move-to-workspace 92 "$id"
expect_box "$natural_x" "X11 first float by workspace move"
stop
[ "$failures" -eq 0 ] || { echo "FLOAT_SIZE_FAILED $failures"; exit 1; }
echo FLOAT_SIZE_COMPLETE
