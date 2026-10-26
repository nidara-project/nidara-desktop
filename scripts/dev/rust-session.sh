#!/usr/bin/env bash
# The Rust desktop as a session of its own, in a Hyalo window of the current session
# (toolkit/PHASE1.md, revision 3): seen without restarting anything, and the session you are
# in left as it is. Hyalo runs nested (--winit) with a runtime directory of its own, so its
# socket, its `msg` and what it writes never reach the live compositor; the session D-Bus is
# shared, so the apps inside use the services on it, whoever serves them.
#
#   scripts/dev/rust-session.sh [COMMAND…]     default: the native Settings
#
# From a checkout: this checkout's Hyalo, nk-settings and exports when they are built
# (`cargo build --release` in hyalo/ and toolkit/; `node --experimental-strip-types
# scripts/export-settings-data.mjs build/settings-data` + export-tokens.mjs), the installed
# ones otherwise. Inside: `nidara-hyalo msg …` with the HYALO_SOCKET this prints.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${XDG_RUNTIME_DIR:?not in a session}"
: "${WAYLAND_DISPLAY:?not in a Wayland session}"

pick() { for f in "$@"; do [ -x "$f" ] && { echo "$f"; return; }; done; return 1; }
hyalo=$(pick "$repo/hyalo/target/release/nidara-hyalo" /usr/bin/nidara-hyalo) \
    || { echo "no nidara-hyalo: build hyalo/ or install it" >&2; exit 1; }
settings=$(pick "$repo/toolkit/target/release/nk-settings" /usr/lib/nidara/nidara-settings-native) || settings=""
data="$repo/build/settings-data"; [ -f "$data/version" ] || data=/usr/share/nidara/settings-data

# A short path: a Unix socket's name is capped (SUN_LEN), and Hyalo's lives in here.
rt="$XDG_RUNTIME_DIR/nr"
mkdir -p "$rt"; chmod 700 "$rt"
parent="$WAYLAND_DISPLAY"; case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac

if [ $# -eq 0 ]; then
    [ -n "$settings" ] || { echo "no native Settings: build toolkit/ (nk-settings)" >&2; exit 1; }
    set -- env NK_SETTINGS_DATA="$data" NK_ICON_REFERENCE="$repo/ui/shell/assets/icons/nidara" "$settings"
fi
printf -v cmd '%q ' "$@"

echo "Hyalo:   $hyalo"
echo "inside:  $cmd"
echo "msg:     HYALO_SOCKET=$rt/nidara-hyalo.wayland-1.sock nidara-hyalo msg …"
# HYALO_SETTINGS: the settings layer Hyalo writes, here and not in ~/.config. The glass
# tokens of this checkout when it has them (an installed export may be older than Hyalo).
vars=(XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY="$parent" HYALO_SETTINGS="$rt/hyalo-settings.toml")
[ -f "$data/tokens/glass.json" ] && vars+=(HYALO_GLASS_TOKENS="$data/tokens/glass.json")
exec env "${vars[@]}" "$hyalo" --winit -c "$cmd"
