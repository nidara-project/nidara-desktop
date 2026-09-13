#!/usr/bin/env bash
# consent-dialog-probe.sh — the real consent prompt, drawn, in a nested Hyprland.
#
# Complements consent-portal-probe.sh (which tests the forwarding with a fake shell):
# here the shell half is the real ConsentService, rendered in a nested Hyprland with a
# headless output, reached through the real bin/nidara-portal on a private bus.
#
# Asserts: the prompt maps as a child of the requesting app's window (xdg-foreign),
# the app closing the request dismisses it and answers 1, and a caller that is NOT the
# portal backend is refused (AccessDenied). Leaves a screenshot in $OUT (default: ./).
#
# 🔴 Isolation, both traps of 2026-09-13: the nested Hyprland runs WITHOUT the session
# bus (env -u DBUS_SESSION_BUS_ADDRESS) and with cursor:sync_gsettings_theme=false, or
# it rewrites the live cursor theme; the private bus gets its env on the daemon's
# command line and a dconf canary. Nothing here writes the live session.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out_dir="${OUT:-$PWD}"
work="$(mktemp -d -t nidara-consent-dlg-XXXXXX)"
cleanup() { [ -n "${HYPR:-}" ] && kill "$HYPR" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/runtime" "$work/config"; chmod 700 "$work/runtime"

"$repo/ui/shell/node_modules/.bin/sass" --no-charset "$repo/ui/shell/style.scss" "$work/style.css" 2>/dev/null
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/consent-dialog-probe.ts" "$work/probe.js" >/dev/null 2>&1

cat > "$work/probe.lua" <<'LUA'
hl.monitor({ output = "PROBE", mode = "1920x1080@60", position = "0x0", scale = 1 })
hl.config({
  misc = { disable_hyprland_logo = true, disable_splash_rendering = true, background_color = 0xff202020 },
  cursor = { sync_gsettings_theme = false },
})
LUA
before=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)
env -u DBUS_SESSION_BUS_ADDRESS -u HYPRLAND_INSTANCE_SIGNATURE Hyprland -c "$work/probe.lua" > "$work/hypr.log" 2>&1 & HYPR=$!
sig=""
for _ in $(seq 50); do
  sig=$(comm -13 <(echo "$before") <(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort) | head -1)
  [ -n "$sig" ] && [ -S "$XDG_RUNTIME_DIR/hypr/$sig/.socket.sock" ] && break; sleep 0.1
done
[ -n "$sig" ] || { echo "FAIL nested Hyprland did not start"; cat "$work/hypr.log"; exit 1; }
hc() { HYPRLAND_INSTANCE_SIGNATURE="$sig" hyprctl "$@"; }
hc output create headless PROBE >/dev/null
wl=$(hc -j instances | jq -r ".[] | select(.instance == \"$sig\") | .wl_socket")
echo "ok   nested Hyprland $sig ($wl)"

env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY \
  WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$wl" XDG_RUNTIME_DIR="$work/runtime" XDG_CONFIG_HOME="$work/config" \
  GIO_USE_VFS=local LANG="${LANG:-es_ES.UTF-8}" work="$work" repo="$repo" sig="$sig" out_dir="$out_dir" \
  REAL_RUNTIME="$XDG_RUNTIME_DIR" \
  dbus-run-session -- bash -c '
set -uo pipefail
fail() { echo "FAIL $*"; tail -20 "$work/probe.log" "$work/portal.log" 2>/dev/null; exit 1; }
ok()   { echo "ok   $*"; }
own()  { for _ in $(seq 80); do gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
           -m org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null | grep -q true && return 0; sleep 0.1; done; return 1; }
hc()   { XDG_RUNTIME_DIR="$REAL_RUNTIME" HYPRLAND_INSTANCE_SIGNATURE="$sig" hyprctl "$@"; }

dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/config/dconf/user" ] || fail "dconf canary did not land in the private database"

gjs -m "$repo/bin/nidara-portal" > "$work/portal.log" 2>&1 & portal=$!
own org.freedesktop.impl.portal.desktop.nidara || fail "backend did not start"
gjs -m "$work/probe.js" "$work/handle" "$work/style.css" > "$work/probe.log" 2>&1 & probe=$!
own org.nidara.Shell || fail "probe shell did not take org.nidara.Shell"
for _ in $(seq 50); do [ -s "$work/handle" ] && break; sleep 0.1; done
[ -s "$work/handle" ] || fail "the requesting window never exported a handle"
handle=$(cat "$work/handle"); ok "requesting window exported $handle"

# A caller that is not the backend must be refused.
denied=$(gdbus call --session --timeout 5 -d org.nidara.Shell -o /org/nidara/Shell/Consent -m org.nidara.Shell.Consent.AccessDialog \
  /x org.gnome.TextEditor "" "Spoof" "" "" "{}" 2>&1 || true)
echo "$denied" | grep -q "AccessDenied" || fail "a foreign caller was NOT refused: $denied"
ok "foreign caller refused (AccessDenied)"

req=/org/freedesktop/portal/desktop/request/1_42/probe
( gdbus call --session --timeout 60 -d org.freedesktop.impl.portal.desktop.nidara -o /org/freedesktop/portal/desktop \
    -m org.freedesktop.impl.portal.Access.AccessDialog "$req" org.gnome.TextEditor "wayland:$handle" \
    "¿Permitir que Editor de texto use la cámara?" "Editor de texto quiere acceder a la cámara." \
    "La app lo necesita para escanear un documento." \
    "{\"choices\": <[(\"remember\", \"Recordar esta decisión\", @a(ss) [], \"true\")]>}" > "$work/reply" 2>&1 ) & pending=$!
sleep 2
clients=$(hc -j clients)
parent=$(echo "$clients" | jq -c ".[] | select(.title == \"Requesting app\") | {at, size}")
dialog=$(echo "$clients" | jq -c ".[] | select(.title != \"Requesting app\") | {class, title, at, size, floating}")
echo "     parent: $parent"; echo "     dialog: $dialog"
[ -n "$dialog" ] || fail "no prompt window mapped"
XDG_RUNTIME_DIR="$REAL_RUNTIME" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" grim -o PROBE "$out_dir/consent-dialog.png" && ok "screenshot $out_dir/consent-dialog.png"
kill -0 $pending 2>/dev/null || fail "AccessDialog answered before anyone did: $(cat "$work/reply")"

gdbus call --session -d org.freedesktop.impl.portal.desktop.nidara -o "$req" -m org.freedesktop.impl.portal.Request.Close >/dev/null 2>&1 \
  || fail "Request.Close not exported"
wait $pending
[ "$(cat "$work/reply")" = "(uint32 1, {'"'"'choices'"'"': <[('"'"'remember'"'"', '"'"'true'"'"')]>})" ] \
  || fail "reply after Close: $(cat "$work/reply")"
ok "closed by the app → $(cat "$work/reply")"
sleep 0.5
[ -z "$(hc -j clients | jq -c ".[] | select(.title != \"Requesting app\")")" ] || fail "prompt still mapped after Close"
ok "prompt dismissed"
kill $probe $portal; true
'
