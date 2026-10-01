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

if [ "$(id -u)" = 0 ]; then
    echo "Run it as yourself, not as root: it builds in your checkout and asks for sudo itself." >&2
    exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
    echo "Removing the Hyalo preview session…"
    # shellcheck disable=SC2086
    sudo rm -f $files
    sudo rmdir /usr/lib/nidara-hyalo /usr/share/nidara/hyalo 2>/dev/null || true
    echo "Done. Your own ~/.config/nidara/hyalo*.toml files, if any, are left as they are."
    exit 0
fi

echo "Building Hyalo (release)…"
(cd "$repo/hyalo" && cargo build --release --locked)

echo "Installing (sudo)…"
sudo install -Dm755 "$repo/hyalo/target/release/nidara-hyalo"         /usr/bin/nidara-hyalo
sudo install -Dm755 "$repo/bin/nidara-hyalo-session"                   /usr/bin/nidara-hyalo-session
sudo install -Dm755 "$repo/hyalo/session/restore-wallpaper"            /usr/lib/nidara-hyalo/restore-wallpaper
sudo install -Dm644 "$repo/config/hyalo/hyalo.toml"                    /usr/share/nidara/hyalo/hyalo.toml
sudo install -Dm644 "$repo/config/wayland-sessions/nidara-hyalo.desktop" /usr/share/wayland-sessions/nidara-hyalo.desktop

echo
echo "Installed: $(nidara-hyalo --version)"
echo "Log out; in the greeter, pick \"Nidara — Hyalo preview\" under the password field."
echo "Ctrl+Alt+Backspace ends the session. To remove it: $0 --uninstall"
