#!/bin/bash
# blur-arm.sh — ONE arm of the layer-blur A/B harness (`references/tech-debt.md` §46).
#
# The question it answers is always the same shape: "what does this surface's blur
# cost while <something> is open, with and without my change?" It restarts the shell,
# parks it on an empty workspace, starts a rectangle that damages the screen at the
# monitor's refresh rate (`blur-damage.js`), puts the shell in the state you name,
# samples the GPU, and prints one line.
#
#   # the floor: nothing open
#   scripts/dev/blur-arm.sh "floor"
#   # arm A — the OLD code, checked out from a ref, as the only variable
#   REF=origin/main FILES=ui/shell/surfaces/island/IslandWindow.ts \
#     scripts/dev/blur-arm.sh "old: full surface" setIsland agent
#   # arm B — the working tree
#   scripts/dev/blur-arm.sh "new: declared rect" setIsland agent
#   # put the tree back when you are done
#   scripts/dev/blur-arm.sh --reset
#
# Everything after the label is handed to `nidara-ipc` verbatim, so any IPC action
# can be the scenario (`toggleCC`, `toggleAppGrid`, `setIsland overview`, …).
#
# TWO NUMBERS, because they answer different questions and a mean hides one of them:
#   gpu=      the steady state — what holding this open costs
#   opening=  the first TRANS seconds from the state change — the animation plus any
#             one-shot work (window captures, first paint) it triggers
#
# And two MODES:
#   DAMAGE=1 (default)  something else is repainting the screen. This is the §46
#                       question: blur is charged as the intersection of that damage
#                       with what each surface declares.
#   DAMAGE=0            an idle desktop, nothing repainting. Answers "does this cost
#                       anything BY ITSELF while open?" — a different question, and
#                       the one that showed the overview's real thumbnails to be free
#                       to hold (0.0 %) while its cost under damage is all region.
#
# HOW TO READ THE OUTPUT
#  - Run the arms ALTERNATED (A,B,B,A), not A,A,B,B: the machine drifts.
#  - 🔑 Check `fps=` on every arm. It must be the monitor's rate. An arm below it
#    was throttled, so it carried a different load than its partner and MEANS
#    NOTHING — throw it away rather than averaging it in. Two rounds of the
#    2026-08-09 measurement died here.
#  - Quote the delta AND the floor. "Opening X costs nothing" is a claim about the
#    floor; "X is 4 points cheaper" is a claim about the delta, and they fail
#    independently.
#  - Do not shorten SECS to make a sweep quicker. The same arm read ~9% at SECS=4
#    and 6.1% at SECS=20 (2026-08-10): a short window sits on top of the transient
#    that the state change itself causes, and it does not average out — it just
#    inflates every arm by a different amount.
#  - The number is tied to WHERE the damage sits (DX/DY/DW/DH): the cost is the
#    intersection of that rect with the region a surface declares, so a surface that
#    declares a region clear of it measures as free. Say where it was.
#
# ⚠️ Traps this script exists to keep you out of:
#  - A stray damage client from an earlier run doubles the load and says nothing, so
#    the kill is by PATTERN, not by pidfile. It lives in this file on purpose, and
#    the reason is sharper than "don't type pkill": `-f` matches the WHOLE command
#    line of every process, so ANY shell whose own argv merely mentions the string
#    kills itself. It does not take a `pkill` to trigger — a caller that ran
#    `chmod +x scripts/dev/blur-damage.js && scripts/dev/blur-arm.sh …` died on this
#    exact line (2026-08-10, exit 144, no output). Invoke this script by a command
#    line that does NOT name the damage file.
#  - The shell must be restarted per arm — a region is stamped from live state and
#    a shell that has seen the other arm's state is not a clean arm.
set -u

REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
SELF="$(readlink -f "$0")"
LOG="${TMPDIR:-/tmp}/nidara-blur-damage.log"
GPU_PATH="${GPU_PATH:-$(echo /sys/class/drm/card*/device/gpu_busy_percent | tr ' ' '\n' | head -1)}"
SECS="${SECS:-20}"
WS="${WS:-6}"          # a workspace with nothing on it: other clients are damage too
SETTLE="${SETTLE:-9}"  # the shell needs its first layout passes before it is measurable

DAMAGE="${DAMAGE:-1}"  # 0 = no damage client: "does this cost anything on an IDLE desktop?"
TRANS="${TRANS:-3}"    # seconds sampled from the state change, reported separately

damage_stop() { pkill -f 'blur-damage\.js'; sleep 0.5; }

sample() {  # sample <seconds> — mean/min/max of GPU busy %, 20 Hz
    { for _ in $(seq $(( $1 * 20 ))); do cat "$GPU_PATH"; sleep 0.05; done; } | awk '
        { s+=$1; n++; if (min==""||$1<min) min=$1; if ($1>max) max=$1 }
        END { printf "%.1f%% (min %d max %d, n=%d)", s/n, min, max, n }'
}

# Which paths a REF arm swapped, so --reset restores THOSE and nothing else. A blunt
# `git checkout HEAD -- .` here would eat whatever else you had in flight.
SWAPPED="${TMPDIR:-/tmp}/nidara-blur-swapped"

if [ "${1:-}" = "--reset" ]; then
    damage_stop
    cd "$REPO"
    if [ -s "$SWAPPED" ]; then
        # shellcheck disable=SC2046
        git checkout -q HEAD -- $(sort -u "$SWAPPED" | tr '\n' ' ')
        echo "reset: restored $(sort -u "$SWAPPED" | tr '\n' ' ')"
        rm -f "$SWAPPED"
    else
        echo "reset: nothing was swapped"
    fi
    systemctl --user restart nidara.service
    exit 0
fi

LABEL="${1:?usage: blur-arm.sh <label> [nidara-ipc args…]   (or --reset)}"
shift

cd "$REPO"
# Every arm states the tree it measures — it never inherits one. An arm with no REF
# means "the working tree", so anything a PREVIOUS arm swapped in is put back first.
# 🔑 Without this the B arm silently re-measures A's code and the two agree, which
# reads exactly like "the change does nothing" (2026-08-10: 8.9 vs 9.4 for a pair
# whose real numbers were 5.9 vs 1.1). Two arms agreeing is the failure this harness
# is most likely to hand you.
if [ -n "${REF:-}" ]; then
    # shellcheck disable=SC2086
    git checkout -q "$REF" -- ${FILES:?REF needs FILES=<paths to swap>}
    for f in $FILES; do echo "$f" >>"$SWAPPED"; done
elif [ -s "$SWAPPED" ]; then
    # shellcheck disable=SC2046
    git checkout -q HEAD -- $(sort -u "$SWAPPED" | tr '\n' ' ')
    echo "   (restored $(sort -u "$SWAPPED" | wc -l) file(s) swapped by an earlier arm)"
    rm -f "$SWAPPED"
fi

systemctl --user restart nidara.service
sleep "$SETTLE"
nidara-ipc focusWorkspace "$WS" >/dev/null

damage_stop
if [ "$DAMAGE" = 1 ]; then
    LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so setsid gjs -m "$REPO/scripts/dev/blur-damage.js" \
        >"$LOG" 2>&1 </dev/null &
    sleep 3
fi

# The state change is applied in the background so the sampler can catch the
# transient it causes — opening a surface costs its animation and any one-shot work
# (window captures, first paint) that a steady-state mean averages into nothing.
OPEN="n/a"
if [ $# -gt 0 ]; then
    nidara-ipc "$@" >/dev/null &
    OPEN=$(sample "$TRANS")
fi
sleep 2
GPU=$(sample "$SECS")

if [ "$DAMAGE" = 1 ]; then FPS=$(grep -ao 'fps=[0-9.]*' "$LOG" | tail -3 | tr '\n' ' ')
else FPS="(no damage: idle-desktop arm)"; fi
damage_stop

printf '%-34s gpu=%s  opening=%s  %s\n' "$LABEL" "$GPU" "$OPEN" "$FPS"
[ -n "${REF:-}" ] && echo "   ⚠️  working tree still holds $REF's $FILES — '$SELF --reset' when done"
exit 0
