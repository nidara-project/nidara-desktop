#!/usr/bin/env bash
# appearance-contract-probe.sh — the appearance contract, end to end, off-screen.
#
# Builds the whole chain an application goes through, on a PRIVATE session bus so
# nothing of the running desktop is read or touched:
#
#   dconf (private XDG_CONFIG_HOME)          ← the HOME of accent-color / color-scheme,
#                                              and of the Nidara-only keys
#                                              (org.nidara.appearance, #573)
#   bin/nidara-portal (THIS checkout)        ← the impl backend
#   /usr/lib/xdg-desktop-portal              ← the real frontend apps talk to
#   ui/lib/nidara-kit/platform/appearance.ts                     ← the client, via appearance-contract-probe.ts
#
# What it shows (the contract lives in ui/lib/nidara-kit/platform/appearance.ts):
#   1. the client's first read comes from the portal, with the values from their homes;
#   2. a leftover appearance.json is ignored — it is nobody's home any more;
#   3. the Nidara namespace carries no `accent` / `is-dark` (one key, one name);
#   4. live changes arrive — for both namespaces — and a burst is one state.
# And a control that must NOT say "portal": the frontend up with no backend of ours.
#
# ⚠️ ISOLATION IS THE WHOLE POINT, and the first version of this script did not have
# it (2026-09-13). The environment was exported INSIDE `dbus-run-session -- bash -c`,
# but a D-Bus-ACTIVATED service inherits the DAEMON's environment, not the caller's:
# dconf-service wrote the real ~/.config/dconf/user and the real desktop changed
# colour. So the variables go on the daemon's command line, a dconf canary proves
# the write landed in the private database before anything else is written, and the
# backend is started explicitly and checked to be the name's owner — never activated
# from /usr/share/dbus-1/services, which would be the INSTALLED copy.
#
# Needs: gjs, esbuild, dbus-run-session, xdg-desktop-portal, dconf. No display.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t nidara-appearance-probe-XXXXXX)"
trap 'rm -rf "$work"' EXIT

"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/appearance-contract-probe.ts" "$work/probe.js" >/dev/null 2>&1

mkdir -p "$work/config/nidara" "$work/runtime" "$work/portals-none" "$work/portals" "$work/schemas"
# This checkout's schemas, not the installed ones: the backend under test reads them.
cp "$repo"/config/gsettings/*.gschema.xml "$work/schemas/"
glib-compile-schemas "$work/schemas"
chmod 700 "$work/runtime"
cp "$repo/config/portal/nidara.portal" "$work/portals/"
printf '[preferred]\ndefault=none\norg.freedesktop.impl.portal.Settings=nidara\n' > "$work/portals/hyprland-portals.conf"
printf '[preferred]\ndefault=none\n' > "$work/portals-none/hyprland-portals.conf"
# A leftover file that DISAGREES with dconf on purpose (green/light/0.3): check 2.
printf '{ "accent": "green", "isDark": false, "windowOpacity": 0.3 }\n' > "$work/config/nidara/appearance.json"

env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/runtime" \
    XDG_CURRENT_DESKTOP=Hyprland GIO_USE_VFS=local GSETTINGS_SCHEMA_DIR="$work/schemas" \
    work="$work" repo="$repo" \
    dbus-run-session -- bash -c '
set -uo pipefail
say() { printf "%s\n" "$*"; }
owner_pid() { gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
  -m org.freedesktop.DBus.GetConnectionUnixProcessID "$1" 2>/dev/null | grep -o "[0-9]\+" | tail -1; }
wait_name() { for _ in $(seq 50); do [ -n "$(owner_pid "$1")" ] && return 0; sleep 0.1; done; return 1; }

# ── canary: a dconf write must land in the PRIVATE database, or nothing else runs ──
dconf write /org/nidara/probe/canary "true"
sleep 0.3
if [ ! -s "$work/config/dconf/user" ]; then
  say "ABORT the dconf canary did not reach $work/config/dconf/user — this bus is not isolated"
  dconf reset /org/nidara/probe/canary
  exit 1
fi
say "ok   dconf is private ($work/config/dconf/user)"

gsettings set org.gnome.desktop.interface accent-color pink
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.nidara.appearance window-opacity 0.6

# ── control: the frontend up, NO backend of ours. Must not report "portal". ──
XDG_DESKTOP_PORTAL_DIR="$work/portals-none" /usr/lib/xdg-desktop-portal -r >"$work/xdp0.log" 2>&1 & xdp=$!
wait_name org.freedesktop.portal.Desktop || { say "FAIL frontend did not start"; exit 1; }
say "── control ──"
gjs -m "$work/probe.js" portal 0 2>&1 | grep -E "^READ|nothing serves|did not answer"
kill $xdp; wait $xdp 2>/dev/null

# ── the real chain ──
gjs -m "$repo/bin/nidara-portal" >"$work/backend.log" 2>&1 & backend=$!
wait_name org.freedesktop.impl.portal.desktop.nidara || { say "FAIL backend did not start"; cat "$work/backend.log"; exit 1; }
[ "$(owner_pid org.freedesktop.impl.portal.desktop.nidara)" = "$backend" ] \
  || { say "FAIL the backend name belongs to another process, not this checkout"; exit 1; }
say "ok   backend is this checkout (pid $backend)"
XDG_DESKTOP_PORTAL_DIR="$work/portals" /usr/lib/xdg-desktop-portal -r >"$work/xdp.log" 2>&1 & xdp=$!
wait_name org.freedesktop.portal.Desktop || { say "FAIL frontend did not start"; exit 1; }

say "── what any app gets from ReadAll ──"
gdbus call --session -d org.freedesktop.portal.Desktop -o /org/freedesktop/portal/desktop \
  -m org.freedesktop.portal.Settings.ReadAll "[\"org.freedesktop.appearance\",\"org.nidara.appearance\"]"

say "── the client: first read, then live changes ──"
gjs -m "$work/probe.js" portal 4000 2>&1 & client=$!
sleep 1
say "   (dconf: accent → teal)"
gsettings set org.gnome.desktop.interface accent-color teal
sleep 0.8
say "   (org.nidara.appearance: window-opacity → 0.7)"
gsettings set org.nidara.appearance window-opacity 0.7
say "   (the leftover file rewritten to red/dark/0.2, which must be IGNORED)"
printf "{ \"accent\": \"red\", \"isDark\": true, \"windowOpacity\": 0.2 }\n" > "$XDG_CONFIG_HOME/nidara/appearance.json"
sleep 0.8
say "   (a burst, one call: accent → orange AND scheme → prefer-light)"
dconf load /org/gnome/desktop/interface/ <<EOF
[/]
accent-color='"'"'orange'"'"'
color-scheme='"'"'prefer-light'"'"'
EOF
wait $client
kill $xdp $backend 2>/dev/null; wait 2>/dev/null
true
'
