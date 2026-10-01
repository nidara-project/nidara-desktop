#!/bin/sh
# The same scene measured in whichever session is running — Hyprland or Hyalo — for #681's
# "blur-off cost against Hyprland on the same scene". Run it once in each, from a terminal;
# compare the two result files.
#
#   hyalo/scripts/measure-session.sh [seconds per phase, default 30]
#
# Scene, both sides: the shell with the Control Center open and the dock, and the terminal
# that runs this. Two phases:
#   still     — your own wallpaper, nothing moving: what an idle desktop costs;
#   animated  — a checkerboard wallpaper sliding every 10 ms: every frame repaints.
# Blur is OFF on both sides: Hyprland's is switched off for the run (and back on after);
# Hyalo blurs nothing until the shell declares its glass (#684).
#
# Measured: mean `gpu_busy_percent` (amdgpu) and the compositor process's CPU. Everything it
# touches is restored on exit, whatever happens: wallpaper, Control Center, Hyprland's blur.
# Results: ~/.local/state/nidara/hyalo/bench-<compositor>-<time>.txt
set -u
secs=${1:-30}
state=${XDG_STATE_HOME:-$HOME/.local/state}/nidara/hyalo
cache=${XDG_CACHE_HOME:-$HOME/.cache}/nidara-bench
mkdir -p "$state" "$cache"

if [ -n "${HYALO_SOCKET:-}" ]; then comp=hyalo; proc=nidara-hyalo
elif [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then comp=hyprland; proc=Hyprland
else echo "Neither Hyalo nor Hyprland is running here." >&2; exit 1; fi
pid=$(pgrep -u "$(id -u)" -x "$proc" | head -1)
busy=$(ls /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | head -1)
[ -n "$busy" ] || { echo "No gpu_busy_percent (this measures an amdgpu)." >&2; exit 1; }
[ -n "$pid" ] || { echo "No $proc process found." >&2; exit 1; }

gif="$cache/anim.gif"
if [ ! -f "$gif" ]; then
    echo "Making the animated wallpaper (once)…"
    args=""
    for i in $(seq 0 4 60); do
        args="$args ( -size 1344x784 pattern:checkerboard -scale 200% -crop 1280x720+$i+$i +repage )"
    done
    # shellcheck disable=SC2086
    magick -delay 1 $args -loop 0 "$gif"
fi

orig_wp=$(awww query 2>/dev/null | sed -n 's/.*image: //p' | head -1)
cc_open=0
restore() {
    [ "$cc_open" = 1 ] && nidara-ipc toggleCC >/dev/null 2>&1
    [ -n "$orig_wp" ] && awww img "$orig_wp" --transition-type none >/dev/null 2>&1
    [ "$comp" = hyprland ] && hyprctl eval -- "hl.config({ decoration = { blur = { enabled = true } } })" >/dev/null 2>&1
    echo "Restored: wallpaper and Control Center$( [ "$comp" = hyprland ] && echo ", Hyprland's blur back on")."
}
trap restore EXIT INT TERM

# Mean GPU busy and compositor CPU over $secs seconds.
measure() {
    tck=$(getconf CLK_TCK)
    cpu0=$(awk '{print $14 + $15}' "/proc/$pid/stat")
    t0=$(date +%s.%N)
    n=0; sum=0; end=$(( $(date +%s) + secs ))
    while [ "$(date +%s)" -lt "$end" ]; do
        sum=$((sum + $(cat "$busy"))); n=$((n + 1)); sleep 0.1
    done
    cpu1=$(awk '{print $14 + $15}' "/proc/$pid/stat")
    t1=$(date +%s.%N)
    awk -v s="$sum" -v n="$n" -v c0="$cpu0" -v c1="$cpu1" -v t0="$t0" -v t1="$t1" -v tck="$tck" \
        'BEGIN { printf "gpu_busy %.1f %%   compositor cpu %.1f %%", s / n, (c1 - c0) / tck / (t1 - t0) * 100 }'
}

[ "$comp" = hyprland ] && hyprctl eval -- "hl.config({ decoration = { blur = { enabled = false } } })" >/dev/null
nidara-ipc toggleCC >/dev/null 2>&1 && cc_open=1
mode=$(if [ "$comp" = hyalo ]; then
    nidara-hyalo msg outputs | python3 -c 'import json,sys
for o in json.load(sys.stdin)["ok"]["outputs"]:
    m = o["current_mode"]
    if m: print(o["name"], "%dx%d@%.0f" % (m["width"], m["height"], m["refresh"] / 1000), "scale", o["scale"])'
else
    hyprctl monitors -j | python3 -c 'import json,sys
for m in json.load(sys.stdin): print(m["name"], "%dx%d@%.0f" % (m["width"], m["height"], m["refreshRate"]), "scale", m["scale"])'
fi)

echo "Measuring $comp in 5 s — leave the mouse and keyboard alone for about $((secs * 2 + 10)) s."
sleep 5
echo "still…"
still=$(measure)
awww img "$gif" --transition-type none >/dev/null 2>&1
sleep 3
echo "animated…"
animated=$(measure)

out="$state/bench-$comp-$(date +%Y%m%d-%H%M%S).txt"
{
    echo "compositor: $comp ($($proc --version 2>/dev/null | head -1 || true))"
    echo "outputs:    $mode"
    echo "blur:       off · Control Center open · ${secs} s per phase"
    echo "still:      $still"
    echo "animated:   $animated"
} | tee "$out"
echo "→ $out"
