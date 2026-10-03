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
#   5. wf-recorder records the region (wlr-screencopy), with frames, and upright too;
#   6. the frame offers a GPU buffer (`linux_dmabuf`) — and where a VA-API driver exists, a
#      hardware-encoded recording (the shell's default) gets frames, upright, and STOPS on
#      SIGINT. Without the offer it waited forever for its first frame, wrote nothing and
#      ignored the Stop button (owner-caught, 2026-10-03). CI's vkms has no VA-API: there only
#      the offer is checked.
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
# --type: without it wl-copy guesses through xdg-mime, and where that is missing (CI's container)
# it offers the PNG as text/plain — the check failed on that, not on Hyalo (2026-10-02).
grim -g "$geo" - | wl-copy --type image/png 2>/dev/null || fail "grim | wl-copy failed"
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

# shm recorders ignore the offer, so any wf-recorder shows it on the wire.
WAYLAND_DEBUG=1 timeout -s INT 1 wf-recorder -y -g "$geo" -f "$log/offer.mp4" >"$log/offer.log" 2>&1 || true
grep -q 'zwlr_screencopy_frame_v1#[0-9]*\.linux_dmabuf(' "$log/offer.log" || fail "the screencopy frame offers no dmabuf (wf-recorder with VA-API waits for one forever)"
echo "ok    screencopy offers a dmabuf"
render=$(ls /dev/dri/renderD* 2>/dev/null | head -n 1 || true)
# Can this machine encode H.264 on the GPU at all? ffmpeg answers without a compositor.
if [ -n "$render" ] && ffmpeg -v error -init_hw_device vaapi=va:"$render" -f lavfi -i nullsrc=s=256x256 \
        -vf format=nv12,hwupload -c:v h264_vaapi -frames:v 1 -f null - >/dev/null 2>&1; then
    st=0
    timeout -s KILL 10 timeout -s INT 3 wf-recorder -y -g "$geo" -c h264_vaapi -d "$render" -f "$log/rec-va.mp4" >"$log/wf-va.log" 2>&1 || st=$?
    # 124: stopped by the INT; 137: still there 7 s after it, killed — the hang.
    [ "$st" -ne 137 ] || fail "wf-recorder (VA-API) did not stop on SIGINT ($(tail -n 3 "$log/wf-va.log"))"
    frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$log/rec-va.mp4" 2>/dev/null || echo 0)
    [ "${frames:-0}" -gt 5 ] || fail "wf-recorder (VA-API) recorded ${frames:-0} frames ($(tail -n 3 "$log/wf-va.log"))"
    ffmpeg -v error -y -ss 1 -i "$log/rec-va.mp4" -frames:v 1 "$log/frame-va.png"
    top=$(colour "$(pixel "$log/frame-va.png" $((w / 2)) $((h / 4)))"); bottom=$(colour "$(pixel "$log/frame-va.png" $((w / 2)) $((h * 3 / 4)))")
    # The buffer is in the OUTPUT's orientation, like the shm one. wf-recorder turns it upright
    # with ffmpeg's vflip, which does NOTHING to a VA-API frame (measured: a red-over-blue frame
    # through hwupload,vflip encodes red over blue) — so on a flipped-180 output (a nested Hyalo)
    # the GPU recording comes out upside down, and that is wf-recorder's, not ours.
    want=red/blue
    [ "$($MSG outputs | jq -r '.ok.outputs[0].transform')" = flipped-180 ] && want=blue/red
    [ "$top/$bottom" = "$want" ] || fail "the VA-API recording is not in the output's orientation: top $top, bottom $bottom ($want expected)"
    echo "ok    recording on the GPU (VA-API, dmabuf): $frames frames, $want, stopped on SIGINT"
else
    echo "skip  recording on the GPU: no VA-API encoder here"
fi
