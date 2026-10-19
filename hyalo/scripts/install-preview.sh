#!/bin/sh
# Install (or remove) the "Nidara — Hyalo preview" session on THIS machine, from this checkout.
#
#   hyalo/scripts/install-preview.sh            build, then install with sudo
#   hyalo/scripts/install-preview.sh --uninstall
#
# For a dev install (`install.sh --dev`): the nidara-hyalo PACKAGE depends on the exact
# nidara-desktop package, which a dev install removes, so it cannot go in there. This puts
# the same files in the same places the package does, and nothing else: the Hyprland
# session, its config and the shell are not touched. The greeter lists the new session the
# next time it starts.
#
# Inside the session: Ctrl+Alt+Backspace ends it (back to the greeter), Ctrl+Alt+F1…F12 switch
# VT. A crash also brings the greeter back and leaves a report in ~/.local/state/nidara/hyalo/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

files="/usr/bin/nidara-hyalo /usr/bin/nidara-hyalo-session /usr/lib/nidara-hyalo/restore-wallpaper
/usr/share/nidara/hyalo/hyalo.toml /usr/share/wayland-sessions/nidara-hyalo.desktop"
# The shell's glass as the token export states it: what Hyalo paints its own glass with (the
# window controls, render/glass_tokens.rs). Without it they fall back to a plain capsule,
# silently. The nidara-desktop package ships it; a dev install has no package, so this puts
# it there — and leaves it alone wherever a package owns it.
tokens=/usr/share/nidara/settings-data/tokens/glass.json
owned() { pacman -Qqo "$1" >/dev/null 2>&1; }

if [ "$(id -u)" = 0 ]; then
    echo "Run it as yourself, not as root: it builds in your checkout and asks for sudo itself." >&2
    exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
    echo "Removing the Hyalo preview session…"
    # shellcheck disable=SC2086
    sudo rm -f $files
    owned "$tokens" || sudo rm -f "$tokens"
    sudo rmdir /usr/lib/nidara-hyalo /usr/share/nidara/hyalo 2>/dev/null || true
    echo "Done. Your own ~/.config/nidara/hyalo*.toml files, if any, are left as they are."
    exit 0
fi

# It builds THIS checkout: one behind main installs a Hyalo without what main has (2026-10-20:
# a checkout from before #884 installed window controls without the glass).
if git -C "$repo" fetch -q origin main 2>/dev/null \
    && ! git -C "$repo" merge-base --is-ancestor origin/main HEAD; then
    echo "This checkout ($(git -C "$repo" rev-parse --short HEAD)) does not have everything in main"
    echo "($(git -C "$repo" rev-parse --short origin/main)): what you install will lack it."
    if [ -t 0 ]; then
        printf 'Install it anyway? [y/N] '
        read -r answer
        case $answer in y|Y|s|S) ;; *) exit 1 ;; esac
    fi
fi

echo "Building Hyalo (release)…"
(cd "$repo/hyalo" && cargo build --release --locked)

echo "Installing (sudo)…"
sudo install -Dm755 "$repo/hyalo/target/release/nidara-hyalo"         /usr/bin/nidara-hyalo
sudo install -Dm755 "$repo/bin/nidara-hyalo-session"                   /usr/bin/nidara-hyalo-session
sudo install -Dm755 "$repo/hyalo/session/restore-wallpaper"            /usr/lib/nidara-hyalo/restore-wallpaper
sudo install -Dm644 "$repo/config/hyalo/hyalo.toml"                    /usr/share/nidara/hyalo/hyalo.toml
sudo install -Dm644 "$repo/config/wayland-sessions/nidara-hyalo.desktop" /usr/share/wayland-sessions/nidara-hyalo.desktop
if owned "$tokens"; then
    echo "The glass tokens come with your nidara-desktop package: left as they are."
else
    echo "Exporting the glass tokens…"
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    node --experimental-strip-types "$repo/scripts/export-tokens.mjs" "$out" >/dev/null
    sudo install -Dm644 "$out/tokens/glass.json" "$tokens"
fi

echo
echo "Installed: $(nidara-hyalo --version)"
echo "Log out; in the greeter, pick \"Nidara — Hyalo preview\" under the password field."
echo "Ctrl+Alt+Backspace ends the session. To remove it: $0 --uninstall"
