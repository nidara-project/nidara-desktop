#!/usr/bin/env bash
# widgets-page-probe.sh — Settings → Widgets via the widget catalogue seam (#571), rendered
# in a nested Hyprland, off the live shell. Prints the equivalence and round-trip results
# and screenshots the page:
#
#   OUT=/tmp/shots scripts/dev/widgets-page-probe.sh
#
# 🔴 Isolation — this probe imports every widget, and with them ThemeManager and
# HyprlandState, so more can leak than from the Apps probe it is modelled on:
#   - HYPRLAND_INSTANCE_SIGNATURE is the NESTED instance's: every `hyprctl` (setcursor,
#     eval) lands there, never on the session's compositor;
#   - HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR are scratch (settings.ini, the
#     Xcursor default, and `systemctl --user` — which cannot find the user manager there);
#   - NIDARA_GREETER_MIRROR_DIR is scratch (ThemeManager/RegionConfig write the mirror);
#   - the private bus gets its env on the daemon's command line, with a dconf canary.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out_dir="${OUT:-$PWD}"; mkdir -p "$out_dir"
work="$(mktemp -d -t nidara-widgets-page-XXXXXX)"
cleanup() { [ -n "${HYPR:-}" ] && kill "$HYPR" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/runtime" "$work/config" "$work/data" "$work/home" "$work/mirror"; chmod 700 "$work/runtime"

# The schema from THIS checkout, not whatever is installed (#573's dev-mode skew trap).
mkdir -p "$work/schemas" && cp "$repo"/config/gsettings/*.gschema.xml "$work/schemas/" && glib-compile-schemas "$work/schemas"
"$repo/ui/shell/node_modules/.bin/sass" --no-charset "$repo/ui/shell/style.scss" "$work/style.css" 2>/dev/null
# The kit's sheet is no longer inside style.css (tech-debt #108 phase 2): compile it
# beside it and tell withKitSheet() where, or it would load the INSTALLED copy.
"$repo/ui/shell/node_modules/.bin/sass" --no-charset "$repo/ui/lib/nidara-kit/styles/kit.scss" "$work/kit.css" 2>/dev/null
export NIDARA_KIT_DIR="$work"
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/widgets-page-probe.ts" "$work/probe.js" >/dev/null 2>&1

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

# hyprctl finds its socket under $XDG_RUNTIME_DIR/hypr, and the probe's runtime dir is
# scratch — link the nested instance (and only it) in.
mkdir -p "$work/runtime/hypr" && ln -s "$XDG_RUNTIME_DIR/hypr/$sig" "$work/runtime/hypr/$sig"

env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY \
  WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$wl" HYPRLAND_INSTANCE_SIGNATURE="$sig" \
  HOME="$work/home" XDG_RUNTIME_DIR="$work/runtime" XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" \
  NIDARA_GREETER_MIRROR_DIR="$work/mirror" NIDARA_SHELL_ROOT="$repo/ui/shell" GIO_USE_VFS=local LANG="${LANG:-es_ES.UTF-8}" \
  GSETTINGS_SCHEMA_DIR="$work/schemas" \
  work="$work" repo="$repo" out_dir="$out_dir" REAL_RUNTIME="$XDG_RUNTIME_DIR" \
  dbus-run-session -- bash -c '
set -uo pipefail
dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/config/dconf/user" ] || { echo "ABORT dconf canary"; exit 1; }
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gjs -m "$repo/bin/nidara-portal" > "$work/portal.log" 2>&1 & portal=$!
gjs -m "$work/probe.js" "$work/style.css" > "$work/probe.log" 2>&1 & p=$!
sleep 4
grep -hE "^(UNREGISTERED|EQUIV|DIFF|ENTRY|ROUNDTRIP|RESTORE|RESULT)" "$work/probe.log" || true
XDG_RUNTIME_DIR="$REAL_RUNTIME" grim -o PROBE "$out_dir/widgets-page.png" && echo "ok   $out_dir/widgets-page.png"
kill $p 2>/dev/null; wait $p 2>/dev/null
grep -iE "error|critical|warn" "$work/probe.log" | grep -v "^\s*$" | head -8
kill $portal; true
'
