#!/bin/sh
# hyalo-motion-check.sh — a window opening and closing (#684, hyalo/compositor/src/wm/motion.rs):
# it grows out of its own middle and fades in; it shrinks a little and fades away after its app
# destroyed it, drawn from a picture taken as it went (render/snapshot.rs). Run INSIDE a Hyalo
# session started with a settings layer (the Hyalo smoke; locally, a nested Hyalo), with
# `hyalo-window-controls-probe` in PATH. Every check reads pixels of Hyalo's screenshots against
# one taken before the window was there (`was`).
#
#   1. it opens: the animation made 30 s long (the fade 10 s), a second in its middle is neither
#      the probe's grey nor what was there (fading in), and a point a tenth of its width in from
#      its left edge is still what was there (it has not grown that far);
#   2. it closes — its app destroys its window, then exits (HYALO_PROBE_TIDY): no longer listed,
#      a second in it is still drawn in its middle, already shrunk off a point near its edge; and
#      gone when the animation is over;
#   3. the same when its app is killed — its surface goes before its window, and the picture is
#      taken then (handlers.rs `destroyed`); and reduce motion (`[animations] enabled = false`):
#      it opened at once;
#   4. a rule's `animate = false`: it opens at once, and closes at once;
#   5. going to another workspace: the one left slides out — to workspace 2, to the left (the
#      animation made 120 s long, so it is 15 to 41 % of the way, a few seconds in: a point just
#      left of where the window was is its grey, one just inside its right edge is not) — and
#      with reduce motion, back at once.
# Controls seen failing nested: listed in hyalo.md → "Opening and closing".
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${MOTION_LOG:-/tmp/hyalo-motion}
mkdir -p "$log"
out="$log/probe.log"
pid=""
fail() { echo "FAIL: $*"; cat "$out" 2>/dev/null; exit 1; }
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; $MSG settings "{\"animations\":null,\"rules\":{\"motion-check\":null}}" >/dev/null 2>&1 || true; $MSG do workspace 1 >/dev/null 2>&1 || true' EXIT
probe_pixel() { gjs -m "$here/hyalo-window-look-probe.js" pixel "$@"; }
win() { $MSG windows | jq -c '.ok.windows[] | select(.title == "window-controls-probe")' | head -n 1; }
scale=$($MSG outputs | jq '.ok.outputs[0].scale')
# Two pixels within `tol` in every channel.
near() { tol=$3; set -- $1 $2; [ $(($1 - $4)) -le $tol ] && [ $(($4 - $1)) -le $tol ] && [ $(($2 - $5)) -le $tol ] && [ $(($5 - $2)) -le $tol ] && [ $(($3 - $6)) -le $tol ] && [ $(($6 - $3)) -le $tol ]; }
GREY="64 64 64"
# A point of the window's box: `fx` of its width from its left, its middle's height, physical.
point() { echo "$1" | jq -r --argjson f "$2" --argjson s "$scale" '"\((.x + .width * $f) * $s | floor) \((.y + .height / 2) * $s | floor)"'; }
# Opens the probe (env first) and waits until it is listed: its window in `w`, its process in
# `pid` (not in a subshell, which would keep both).
open_probe() {
    env "$@" hyalo-window-controls-probe >"$out" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do
        w=$(win)
        [ -n "$w" ] && [ "$(echo "$w" | jq -r .visible)" = true ] && return 0
        sleep 0.05
    done
    fail "the probe's window never showed"
}
gone() { for _ in $(seq 1 100); do [ -z "$(win)" ] && return 0; sleep 0.05; done; fail "its window is still listed"; }

# What was there — once a window the check before closed has finished fading away (`close` and
# `fade` are 400 ms by default): in CI the minimize check kills its probe right before this one,
# and a first run compared against its closing picture.
sleep 1
$MSG screenshot "$log/was.png" >/dev/null || fail "no screenshot"

# 1. Opening.
$MSG settings '{"animations":{"open":30000,"fade":10000}}' >/dev/null || fail "Hyalo refused [animations] open/fade (a Hyalo that does not animate windows)"
open_probe HYALO_PROBE_TIDY=1
id=$(echo "$w" | jq -r .id)
mid=$(point "$w" 0.5); edge=$(point "$w" 0.1)
was_mid=$(probe_pixel "$log/was.png" $mid); was_edge=$(probe_pixel "$log/was.png" $edge)
sleep 1
$MSG screenshot "$log/opening.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/opening.png" $mid)
near "$now" "$GREY" 3 && fail "a second into opening, its middle is already its grey ('$now'): it opened at once"
near "$now" "$was_mid" 6 && fail "a second into opening, its middle is what was there ('$now'): it is not drawn"
now=$(probe_pixel "$log/opening.png" $edge)
near "$now" "$was_edge" 6 || fail "a second into opening, near its edge ($edge) is '$now', not what was there ('$was_edge'): it did not grow from its middle"
echo "ok    it opens: grown from its middle and fading in, a second in"

# 2. Closing, its window destroyed by its app.
$MSG settings '{"animations":{"open":null,"close":6000,"fade":6000}}' >/dev/null
$MSG do close-window "$id" >/dev/null || fail "close refused"
gone
wait "$pid" 2>/dev/null || true; pid=""
grep -q '^CLOSED' "$out" || fail "the probe was not asked to close"
sleep 0.8
$MSG screenshot "$log/closing.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/closing.png" $mid)
near "$now" "$was_mid" 6 && fail "closing, its middle is already what was there ('$now'): no picture of it"
near_edge=$(point "$w" 0.03)
now=$(probe_pixel "$log/closing.png" $near_edge); then=$(probe_pixel "$log/was.png" $near_edge)
near "$now" "$then" 6 || fail "closing, near its edge ($near_edge) is '$now', not what was there ('$then'): it did not shrink"
sleep 5.6
$MSG screenshot "$log/closed.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/closed.png" $mid)
near "$now" "$was_mid" 6 || fail "after its animation, its middle is '$now', not what was there ('$was_mid')"
echo "ok    it closes: shrunk and fading where it was, then gone"

# 3. Killed — and reduce motion: it opens at once.
$MSG settings '{"animations":{"enabled":false}}' >/dev/null
open_probe
sleep 0.3
$MSG screenshot "$log/at-once.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/at-once.png" $mid)
near "$now" "$GREY" 3 || fail "with reduce motion, its middle is '$now' when it shows, not its grey: it did not open at once"
$MSG settings '{"animations":{"enabled":null}}' >/dev/null
kill -9 "$pid"; wait "$pid" 2>/dev/null || true; pid=""
gone
sleep 0.8
$MSG screenshot "$log/killed.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/killed.png" $mid)
near "$now" "$was_mid" 6 && fail "killed, its middle is already what was there ('$now'): no picture of it"
sleep 5.6
echo "ok    killed, it closes the same way; with reduce motion it opened at once"

# 4. A rule takes the animations from it.
$MSG settings '{"animations":{"close":null,"fade":null,"open":30000},"rules":{"motion-check":{"match":{"app_id":"^hyalo-window-controls-probe$"},"animate":false}}}' >/dev/null \
    || fail "Hyalo refused a rule with animate = false"
open_probe HYALO_PROBE_TIDY=1
id=$(echo "$w" | jq -r .id)
sleep 0.3
$MSG screenshot "$log/rule-open.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/rule-open.png" $mid)
near "$now" "$GREY" 3 || fail "with animate = false, its middle is '$now' when it shows, not its grey"
$MSG do close-window "$id" >/dev/null
gone
sleep 0.3
$MSG screenshot "$log/rule-closed.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/rule-closed.png" $mid)
near "$now" "$was_mid" 6 || fail "with animate = false, closed, its middle is '$now', not what was there"
wait "$pid" 2>/dev/null || true; pid=""
echo "ok    a rule's animate = false: it opens and closes at once"

# 5. Another workspace: the one shown slides out sideways.
$MSG settings '{"animations":{"open":null,"workspace":120000},"rules":{"motion-check":null}}' >/dev/null \
    || fail "Hyalo refused [animations] workspace (a Hyalo that does not slide workspaces)"
open_probe HYALO_PROBE_TIDY=1
sleep 1
ws=$($MSG workspaces | jq -r '.ok.workspaces[] | select(.active and .focused and (.special | not)) | .id' | head -n 1)
other=$((ws + 1))
row=$(echo "$w" | jq -r --argjson s "$scale" '(.y + .height / 2) * $s | floor')
left=$(echo "$w" | jq -r --argjson s "$scale" '(.x - 20) * $s | floor')
right=$(echo "$w" | jq -r --argjson s "$scale" '(.x + .width - 20) * $s | floor')
was_left=$(probe_pixel "$log/was.png" $left $row)
$MSG do workspace "$other" >/dev/null || fail "workspace $other refused"
sleep 0.6
$MSG screenshot "$log/sliding.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/sliding.png" $left $row)
near "$now" "$GREY" 3 || fail "going to workspace $other, just left of where the window was ($left $row) is '$now' (was '$was_left'), not its grey: workspace $ws did not slide out to the left"
now=$(probe_pixel "$log/sliding.png" $right $row)
near "$now" "$GREY" 3 && fail "going to workspace $other, just inside its right edge ($right $row) it is still its grey: it did not move"
echo "ok    another workspace: the one left slides out sideways"
$MSG settings '{"animations":{"workspace":null,"enabled":false}}' >/dev/null
$MSG do workspace "$ws" >/dev/null
sleep 0.3
$MSG screenshot "$log/back.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/back.png" $mid)
near "$now" "$GREY" 3 || fail "with reduce motion, back on workspace $ws its middle is '$now', not its grey: it did not come back at once"
now=$(probe_pixel "$log/back.png" $left $row)
near "$now" "$GREY" 3 && fail "with reduce motion, left of the window ($left $row) is still its grey"
$MSG settings '{"animations":{"enabled":null}}' >/dev/null
$MSG do close-window "$(echo "$w" | jq -r .id)" >/dev/null
gone
wait "$pid" 2>/dev/null || true; pid=""
echo "ok    with reduce motion, a workspace comes back at once"
