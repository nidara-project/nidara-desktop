#!/usr/bin/env bash
# gen-dconf-defaults.sh — the system dconf keyfile, generated from defaults/appearance.json.
#
#   scripts/gen-dconf-defaults.sh [defaults/appearance.json] > …/etc/dconf/db/local.d/00-nidara-appearance
#
# ONE generator for both install paths — the PKGBUILD (packaged installs) and
# install.sh --dev — so the value a fresh account starts with cannot differ between
# them. Before this existed only the PKGBUILD wrote it, and a --dev machine had no
# system default at all (nidara-setup's "[WARN] the system icon-theme default is not
# in effect" on every run).
#
# What goes in, and why each key is a system DEFAULT rather than a per-user write:
# see the comment above its use in packaging/nidara/PKGBUILD, and the appearance
# contract in .claude/skills/nidara/references/architecture.md (accent-color and
# color-scheme LIVE in gsettings).
set -euo pipefail
src="${1:-defaults/appearance.json}"
[ -f "$src" ] || { echo "gen-dconf-defaults: no such file: $src" >&2; exit 1; }

field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$src" | head -1; }
icon_theme="$(field iconTheme)"
accent="$(field accent)"
is_dark="$(sed -n 's/.*"isDark"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$src" | head -1)"
[ -n "$icon_theme" ] || { echo "gen-dconf-defaults: no iconTheme in $src" >&2; exit 1; }
[ -n "$accent" ]     || { echo "gen-dconf-defaults: no accent in $src" >&2; exit 1; }
[ -n "$is_dark" ]    || { echo "gen-dconf-defaults: no isDark in $src" >&2; exit 1; }
scheme=prefer-light; [ "$is_dark" = true ] && scheme=prefer-dark

cat <<KEYFILE
# Generated from defaults/appearance.json by scripts/gen-dconf-defaults.sh. Edit that
# file, not this one — and note this is a DEFAULT: whatever the person chose in their
# own dconf wins, because /etc/dconf/profile/user reads user-db first.
[org/gnome/desktop/interface]
icon-theme='$icon_theme'
accent-color='$accent'
color-scheme='$scheme'
KEYFILE
