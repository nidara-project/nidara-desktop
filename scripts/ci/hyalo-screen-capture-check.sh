#!/bin/sh
# hyalo-screen-capture-check.sh — capturing the screen on Hyalo, and the clipboard it lands in
# (hyalo/compositor/src/capture.rs, protocols/screencopy.rs, the data-control protocols). Run
# INSIDE a Hyalo session (the Hyalo smoke; locally, a nested Hyalo), with grim, wl-clipboard,
# wf-recorder and ffmpeg installed.
#
#   1. grim takes the whole output, at the output's size (ext-image-copy-capture, output source);
#   2. grim takes a region — and it is UPRIGHT: the probe's red half on top, blue below;
#   3. grim | wl-copy puts a PNG on the clipboard, and wl-paste gives it back (the screenshot
#      tile, Print: what was broken until 2026-10-02 — grim found no capture protocol);
#   4. wl-paste --watch sees a copy (data-control: the clipboard history);
#   5. wf-recorder records the region (wlr-screencopy), with frames, and upright too.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${CAPTURE_LOG:-/tmp/hyalo-screen-capture}
mkdir -p "$log"
fail() { echo "FAIL: $*"; tail -n 20 "$log"/*.log 2>/dev/null; exit 1; }
pixel() { gjs -m "$here/hyalo-screen-capture-probe.js" pixel "$@"; }
# "R G B" → red | blue | other
colour() { set -- $1; if [ "$1" -gt 180 ] && [ "$3" -lt 80 ]; then echo red; elif [ "$3" -gt 180 ] && [ "$1" -lt 80 ]; then echo blue; else echo "other($*)"; fi; }
dims() { file "$1" | sed -n 's/.*PNG image data, \([0-9]*\) x \([0-9]*\).*/\1x\2/p'; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT

$MSG do workspace 1 >/dev/null
gjs -m "$here/hyalo-screen-capture-probe.js" window >"$log/probe.log" 2>&1 &
pids="$pids $!"
geo=""
for _ in $(seq 1 40); do
    geo=$($MSG windows | jq -r '.ok.windows[] | select(.title == "screen-capture-probe" and .width > 0) | "\(.x),\(.y) \(.width)x\(.height)"')
    [ -n "$geo" ] && break; sleep 0.25
done
[ -n "$geo" ] || fail "the probe window never appeared"
sleep 0.5

out=$($MSG outputs | jq -c '.ok.outputs[0].logical_size')
grim "$log/full.png" 2>"$log/grim.log" || fail "grim could not take the screen: $(cat "$log/grim.log")"
[ -n "$(dims "$log/full.png")" ] || fail "grim wrote no PNG"
echo "ok    whole output: $(dims "$log/full.png") (output $out)"

grim -g "$geo" "$log/region.png" 2>"$log/grim.log" || fail "grim could not take the region $geo: $(cat "$log/grim.log")"
w=${geo#* }; w=${w%x*}; h=${geo#*x}
top=$(colour "$(pixel "$log/region.png" $((w / 2)) $((h / 4)))"); bottom=$(colour "$(pixel "$log/region.png" $((w / 2)) $((h * 3 / 4)))")
[ "$top/$bottom" = "red/blue" ] || fail "the region is not upright: top $top, bottom $bottom (red above blue expected)"
echo "ok    region $geo: upright (red on top, blue below)"

timeout 5 wl-paste --type text --watch sh -c 'echo "SAW $(cat)"' >"$log/watch.log" 2>&1 &
pids="$pids $!"
sleep 0.5
# wl-copy stays behind serving the clipboard: its output goes nowhere, or it lands in ours later.
grim -g "$geo" - | wl-copy 2>/dev/null || fail "grim | wl-copy failed"
sleep 0.5
wl-paste --list-types | grep -qx image/png || fail "the screenshot is not on the clipboard ($(wl-paste --list-types | tr '\n' ' '))"
wl-paste --type image/png >"$log/pasted.png"
[ "$(dims "$log/pasted.png")" = "$(dims "$log/region.png")" ] || fail "the pasted image is not the screenshot"
echo "ok    clipboard: grim | wl-copy, and wl-paste gives the PNG back"

echo hyalo-capture-check | wl-copy 2>/dev/null
sleep 1
grep -q "SAW hyalo-capture-check" "$log/watch.log" || fail "wl-paste --watch did not see the copy (data-control)"
echo "ok    data-control: wl-paste --watch saw the copy (the clipboard history)"

timeout -s INT 3 wf-recorder -y -g "$geo" -f "$log/rec.mp4" >"$log/wf.log" 2>&1 || true
frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$log/rec.mp4" 2>/dev/null || echo 0)
[ "${frames:-0}" -gt 5 ] || fail "wf-recorder recorded ${frames:-0} frames ($(tail -n 3 "$log/wf.log"))"
ffmpeg -v error -y -ss 1 -i "$log/rec.mp4" -frames:v 1 "$log/frame.png"
top=$(colour "$(pixel "$log/frame.png" $((w / 2)) $((h / 4)))"); bottom=$(colour "$(pixel "$log/frame.png" $((w / 2)) $((h * 3 / 4)))")
[ "$top/$bottom" = "red/blue" ] || fail "the recording is not upright: top $top, bottom $bottom"
echo "ok    recording: $frames frames, upright"
