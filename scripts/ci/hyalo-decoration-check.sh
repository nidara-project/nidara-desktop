#!/bin/sh
# hyalo-decoration-check.sh — who draws a window's title bar (hyalo/compositor/src/shell/decoration.rs):
# Hyalo, as Hyprland did, by both protocols — so an app that asks drops its own bar and its
# shadow margin, and is rounded like any other window. Run INSIDE a Hyalo session with
# `hyalo-decoration-probe` in PATH.
#
#   1. xdg-decoration: asked for client-side, then unset — server-side both times;
#   2. KDE's server-decoration: server-side by default, and a request for client-side does not
#      turn it;
#   3. each probe window, drawn as kitty draws itself with the answer, is rounded (`look`). A
#      client-side answer would give it a shadow margin, which Hyalo leaves square: the control
#      is the same probe against a Hyalo without the protocols, which fails here.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
MSG=${MSG:-nidara-hyalo msg}
log=${DECORATION_LOG:-/tmp/hyalo-decoration}
mkdir -p "$log"
fail() { echo "FAIL: $*"; cat "$log/probe.log" 2>/dev/null; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null || true' EXIT
said() { sed -n "s/^$1 //p" "$log/probe.log"; }
look() { $MSG windows | jq -c --arg t "$1" '.ok.windows[] | select(.title == $t) | .look'; }

hyalo-decoration-probe >"$log/probe.log" 2>&1 &
pids="$pids $!"
for _ in $(seq 1 40); do grep -q SHOWN "$log/probe.log" && break; sleep 0.25; done
grep -q SHOWN "$log/probe.log" || fail "the probe never showed its windows"
sleep 0.5

[ "$(said XDG_ASKED_CLIENT)" = server ] || fail "xdg-decoration: asked for client-side, told $(said XDG_ASKED_CLIENT) (server expected)"
[ "$(said XDG_UNSET)" = server ] || fail "xdg-decoration: after unset_mode, told $(said XDG_UNSET) (server expected)"
echo "ok    xdg-decoration: server-side, whatever the client asked"

[ "$(said KDE_DEFAULT)" = server ] || fail "KDE server-decoration: default $(said KDE_DEFAULT) (server expected)"
[ "$(said KDE_MODE)" = server ] || fail "KDE server-decoration: after asking for client-side, mode $(said KDE_MODE) (server expected)"
echo "ok    KDE server-decoration: server-side by default, and it stays so"

for t in decoration-probe-xdg decoration-probe-kde; do
    l=$(look "$t")
    [ "$(echo "$l" | jq -r .rounded)" = true ] || fail "$t is not rounded ($l): a margin of its own, or a rule (no app id)"
done
echo "ok    both windows drew no margin of their own, and are rounded"
