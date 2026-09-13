#!/usr/bin/env bash
# install-permissions-probe.sh — core/FlatpakPermissions.ts against the real `flatpak
# override`, never the user's own overrides.
#
# FLATPAK_USER_DIR and FLATPAK_SYSTEM_DIR point at a scratch installation holding one fake
# app (just its `metadata`: `flatpak override` does not need the app to exist). The probe
# refuses to run if the real user overrides directory changes while it runs.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t nidara-install-perms-XXXXXX)"; trap 'rm -rf "$work"' EXIT
real="${XDG_DATA_HOME:-$HOME/.local/share}/flatpak/overrides"
before="$(ls -la --time-style=full-iso "$real" 2>/dev/null || true)"

app="$work/user/app/org.example.Probe/x86_64/stable/active"
mkdir -p "$app" "$work/sys"
ln -s x86_64/stable "$work/user/app/org.example.Probe/current"
cat > "$app/metadata" <<'EOF'
[Application]
name=org.example.Probe

[Context]
sockets=wayland;pulseaudio;
devices=all;
filesystems=host;xdg-download:ro;
EOF

"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/install-permissions-probe.ts" "$work/probe.js" >/dev/null 2>&1
rc=0
FLATPAK_USER_DIR="$work/user" FLATPAK_SYSTEM_DIR="$work/sys" gjs -m "$work/probe.js" || rc=$?

after="$(ls -la --time-style=full-iso "$real" 2>/dev/null || true)"
[ "$before" = "$after" ] || { echo "FAIL the real overrides directory changed: $real"; exit 1; }
echo "real overrides untouched: $real"
exit $rc
