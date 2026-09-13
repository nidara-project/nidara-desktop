#!/usr/bin/env bash
# app-page-probe.sh — Settings → Apps rendered in a nested Hyprland, off the live shell.
#
# Screenshots the app list and each app page named on the command line, in dark mode,
# with the real page builders and the Settings stylesheet:
#
#   OUT=/tmp/shots scripts/dev/app-page-probe.sh org.gnome.clocks com.google.Chrome
#
# 🔴 Isolation (both traps of 2026-09-13): the nested Hyprland runs without the session
# bus and with cursor:sync_gsettings_theme=false; the private bus gets its env on the
# daemon's command line and a dconf canary; the colour scheme is set in THAT dconf only.
# XDG_DATA_HOME is private too: it is where the portal's PermissionStore keeps its tables,
# and the app page reads (and its rows can write) them. Seed decisions with PERM_SEED:
#   PERM_SEED="devices camera org.gnome.clocks yes;wallpaper wallpaper org.gnome.clocks no"
# The Flatpak installation is a scratch one too (FLATPAK_USER_DIR): each Flatpak named on
# the command line gets a copy of its real `metadata` and nothing else, so the page's
# install-time switches read what the app declared and can never write the real overrides.
# Seed an override with INSTALL_SEED (flatpak override flags, per app):
#   INSTALL_SEED="org.gnome.clocks --nosocket=pulseaudio --unshare=network"
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out_dir="${OUT:-$PWD}"; mkdir -p "$out_dir"
work="$(mktemp -d -t nidara-app-page-XXXXXX)"
cleanup() { [ -n "${HYPR:-}" ] && kill "$HYPR" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/runtime" "$work/config" "$work/data" "$work/flatpak-sys"; chmod 700 "$work/runtime"
for id in "$@"; do
  loc=$(flatpak info --show-location "$id" 2>/dev/null) || continue
  mkdir -p "$work/flatpak/app/$id/current/active"
  cp "$loc/metadata" "$work/flatpak/app/$id/current/active/metadata"
done
if [ -n "${INSTALL_SEED:-}" ]; then
  read -r seed_app seed_flags <<< "$INSTALL_SEED"
  # shellcheck disable=SC2086
  FLATPAK_USER_DIR="$work/flatpak" FLATPAK_SYSTEM_DIR="$work/flatpak-sys" flatpak override --user $seed_flags "$seed_app"
  echo "seed override $seed_app: $(tr '\n' ' ' < "$work/flatpak/overrides/$seed_app")"
fi

"$repo/ui/shell/node_modules/.bin/sass" --no-charset "$repo/ui/shell/style.scss" "$work/style.css" 2>/dev/null
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/app-page-probe.ts" "$work/probe.js" >/dev/null 2>&1

cat > "$work/probe.lua" <<'LUA'
hl.monitor({ output = "PROBE", mode = "1920x1080@60", position = "0x0", scale = 1 })
hl.config({
  misc = { disable_hyprland_logo = true, disable_splash_rendering = true, background_color = 0xff3a2a4a },
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
[ -n "$sig" ] || { echo "FAIL nested Hyprland did not start"; exit 1; }
HYPRLAND_INSTANCE_SIGNATURE="$sig" hyprctl output create headless PROBE >/dev/null
wl=$(HYPRLAND_INSTANCE_SIGNATURE="$sig" hyprctl -j instances | jq -r ".[] | select(.instance == \"$sig\") | .wl_socket")

env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY \
  WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$wl" XDG_RUNTIME_DIR="$work/runtime" XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" \
  FLATPAK_USER_DIR="$work/flatpak" FLATPAK_SYSTEM_DIR="$work/flatpak-sys" \
  XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:/var/lib/flatpak/exports/share:$HOME/.local/share/flatpak/exports/share" \
  NIDARA_SHELL_ROOT="$repo/ui/shell" GIO_USE_VFS=local LANG="${LANG:-es_ES.UTF-8}" \
  work="$work" repo="$repo" out_dir="$out_dir" REAL_RUNTIME="$XDG_RUNTIME_DIR" PERM_SEED="${PERM_SEED:-}" \
  dbus-run-session -- bash -c '
set -uo pipefail
dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/config/dconf/user" ] || { echo "ABORT dconf canary"; exit 1; }
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.gnome.desktop.interface accent-color blue
gjs -m "$repo/bin/nidara-portal" > "$work/portal.log" 2>&1 & portal=$!
IFS=";" read -ra seeds <<< "${PERM_SEED:-}"
for seed in "${seeds[@]}"; do
  read -r tbl pid papp pval <<< "$seed"
  gdbus call --session -d org.freedesktop.impl.portal.PermissionStore -o /org/freedesktop/impl/portal/PermissionStore \
    -m org.freedesktop.impl.portal.PermissionStore.SetPermission "$tbl" true "$pid" "$papp" "[\"$pval\"]" >/dev/null && echo "seed $tbl/$pid $papp=$pval"
done
for t in list "$@"; do
  gjs -m "$work/probe.js" "$t" "$work/style.css" > "$work/probe-$t.log" 2>&1 & p=$!
  sleep 3
  grep -hE "^(ORIGIN|LIST|HIDDEN)" "$work/probe-$t.log" || true
  XDG_RUNTIME_DIR="$REAL_RUNTIME" grim -o PROBE "$out_dir/app-page-$t.png" && echo "ok   $out_dir/app-page-$t.png"
  kill $p 2>/dev/null; wait $p 2>/dev/null
  grep -iE "error|critical" "$work/probe-$t.log" | head -3
done
kill $portal; true
' _ "$@"
