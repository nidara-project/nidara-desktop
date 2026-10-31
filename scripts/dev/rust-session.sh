#!/usr/bin/env bash
# The Rust desktop as a session of its own, in a Hyalo window of the current session
# (toolkit/PHASE1.md, revision 3): seen without restarting anything, and the session you are
# in left as it is. Its own runtime directory (Hyalo's socket, `msg`, the accessibility bus),
# its own session D-Bus, its own settings (GSettings on the keyfile backend under the state
# directory below) and its own services: nidara-sessiond serves Config1 there. Nothing it
# changes reaches the live session, and nothing of the live session serves it.
#
#   scripts/dev/rust-session.sh [--network] [--bluetooth] [--audio] [--media] [COMMAND…]   default: native Settings
# Network/Bluetooth are explicit: never use it alongside the daily TS shell agent. A test
# must also provide a private DBUS_SYSTEM_BUS_ADDRESS, not the host NetworkManager/BlueZ.
# OBEX must be a private fake on the nested session bus too.
#
# From a checkout: this checkout's Hyalo, nidara-sessiond, nk-settings and exports when they
# are built (`cargo build --release` in hyalo/ and toolkit/;
# `cargo build --release --workspace --features audio-native` in session/; `node
# --experimental-strip-types scripts/export-settings-data.mjs build/settings-data` +
# export-tokens.mjs), the installed ones otherwise. Inside: `nidara-hyalo msg …` with the
# HYALO_SOCKET this prints. The session's settings persist in $state; delete it to start over.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${XDG_RUNTIME_DIR:?not in a session}"
: "${WAYLAND_DISPLAY:?not in a Wayland session}"

pick() { for f in "$@"; do [ -x "$f" ] && { echo "$f"; return; }; done; return 1; }
hyalo=$(pick "${HYALO_BIN:-}" "$repo/hyalo/target/release/nidara-hyalo" /usr/bin/nidara-hyalo) \
    || { echo "no nidara-hyalo: build hyalo/ or install it" >&2; exit 1; }
sessiond=$(pick "${SESSIOND_BIN:-}" "$repo/session/target/release/nidara-sessiond" /usr/bin/nidara-sessiond) \
    || { echo "no nidara-sessiond: build session/ or install it" >&2; exit 1; }
selector=$(pick "${DISPLAY_SELECTOR_BIN:-}" "$repo/toolkit/target/release/nidara-display-selector" "$repo/toolkit/target/debug/nidara-display-selector" /usr/bin/nidara-display-selector) || selector=""
ipc=$(pick "${NIDARA_IPC_BIN:-}" "$repo/session/target/release/nidara-ipc" "$repo/session/target/debug/nidara-ipc" /usr/bin/nidara-ipc) \
    || { echo "no native nidara-ipc: cargo build --manifest-path session/Cargo.toml -p nidara-ipc" >&2; exit 1; }
if ! "$ipc" --help | grep -q -- '--session=ts|rust'; then
    echo "nidara-ipc is too old: build session/ (including -p nidara-ipc)" >&2; exit 1
fi
settings=$(pick "${NK_SETTINGS_BIN:-}" "$repo/toolkit/target/release/nk-settings" /usr/lib/nidara/nidara-settings-native) || settings=""
data="${NK_SETTINGS_DATA:-$repo/build/settings-data}"; [ -f "$data/version" ] || data=/usr/share/nidara/settings-data

# A short path: a Unix socket's name is capped (SUN_LEN), and Hyalo's lives in here.
rt="$XDG_RUNTIME_DIR/nr"
mkdir -p "$rt"; chmod 700 "$rt"
# On disk, not in the runtime directory (RAM): the session's settings outlive a run.
state="${XDG_DATA_HOME:-$HOME/.local/share}/nidara/rust-session"
mkdir -p "$state/config/nidara"
# This checkout's settings schema over the installed ones: an installed copy older than the
# checkout lacks its new keys, and a service reading one (Applications1's dock layout) then
# reports itself unavailable — the dock showed only the Trash.
schemas="$state/schemas"
if [ -f "$repo/config/gsettings/org.nidara.gschema.xml" ]; then
    rm -rf "$schemas"; mkdir -p "$schemas"
    cp /usr/share/glib-2.0/schemas/*.gschema.xml "$schemas/" 2>/dev/null || true
    cp "$repo/config/gsettings/org.nidara.gschema.xml" "$schemas/"
    glib-compile-schemas "$schemas" && export GSETTINGS_SCHEMA_DIR="$schemas"
fi
service_flags=""
while [ $# -gt 0 ]; do
    case "$1" in
        --network|--bluetooth|--audio|--media|--power|--power-read-only|--applications) service_flags+=" $1"; shift ;;
        *) break ;;
    esac
done
parent="$WAYLAND_DISPLAY"; case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac

if [ $# -eq 0 ]; then
    [ -n "$settings" ] || { echo "no native Settings: build toolkit/ (nk-settings)" >&2; exit 1; }
    set -- env NK_SETTINGS_DATA="$data" NK_ICON_REFERENCE="$repo/ui/shell/assets/icons/nidara" "$settings"
fi
printf -v app '%q ' "$@"
# The session's services first, then what was asked for. The accessibility registry by hand:
# its bus's broker (--scope user) would ask the user's systemd to start it, which starts it
# with the LIVE session's environment, on the live bus — and the native apps refuse to run
# without accessibility.
registryd=/usr/lib/at-spi2-registryd
# Every process started in there writes its PID here, and leaves with the window: Hyalo does not
# take its children with it, and a session left behind is what kept the live one locked all
# night (#956). The wallpaper daemon is the session's own (its socket in $rt, its cache below).
children="$rt/children"
: >"$children"
q() { printf '%q' "$1"; }
bg() { echo "$* & echo \$! >>$(q "$children");"; }
# D-Bus activation starts an app with the BUS's environment, and the bus came up before Hyalo:
# without this an activated app (Amberol from the dock) opened on the live screen instead.
cmd="dbus-update-activation-environment WAYLAND_DISPLAY \${DISPLAY:+DISPLAY} 2>/dev/null; "
cmd+="$(bg "$(q "$sessiond") --config$service_flags") $(bg "$(q "$registryd") --use-gnome-session")"
awww=$(command -v awww-daemon) && cmd+=" $(bg "$(q "$awww")")"
cmd+=" echo \$\$ >>$(q "$children"); exec $app"

echo "Hyalo:     $hyalo"
echo "services:  $sessiond --config$service_flags${awww:+, $awww}"
echo "inside:    $app"
echo "settings:  $state"
echo "msg:       HYALO_SOCKET=$rt/nidara-hyalo.wayland-1.sock nidara-hyalo msg …"
# HYALO_SETTINGS: the settings layer Hyalo writes, here and not in ~/.config. The glass
# tokens of this checkout when it has them (an installed export may be older than Hyalo).
# Use the factory rules/bindings unchanged, with this checkout's selector and
# child tracking. HYALO_CONFIG never falls through to the owner's live config.
mkdir -p "$rt/bin"
if [ -n "$ipc" ]; then
    printf '%s\n' '#!/usr/bin/env bash' "exec $(q "$ipc") --session=rust \"\$@\"" > "$rt/bin/nidara-ipc"
    chmod 700 "$rt/bin/nidara-ipc"
fi
if [ -n "$selector" ]; then
    printf '%s\n' '#!/usr/bin/env bash' "echo \$\$ >>$(q "$children")" "exec $(q "$selector") \"\$@\"" > "$rt/bin/nidara-display-selector"
    chmod 700 "$rt/bin/nidara-display-selector"
fi
vars=(NIDARA_SESSION=rust PATH="$rt/bin:$repo/bin:$PATH" XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY="$parent" HYALO_SETTINGS="$rt/hyalo-settings.toml"
    XDG_CONFIG_HOME="$state/config" XDG_DATA_HOME="$state/data" XDG_CACHE_HOME="$state/cache"
    XDG_STATE_HOME="$state/state" GSETTINGS_BACKEND=keyfile HYALO_CONFIG="$repo/config/hyalo/hyalo.toml")
[ -f "$data/tokens/glass.json" ] && vars+=(HYALO_GLASS_TOKENS="$data/tokens/glass.json")
leave() { xargs -r kill 2>/dev/null <"$children" || true; rm -f "$children"; }
trap leave EXIT
trap 'exit 130' INT TERM
env "${vars[@]}" dbus-run-session -- "$hyalo" --winit -c "sh -c $(q "$cmd")"
