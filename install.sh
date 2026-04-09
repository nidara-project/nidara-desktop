#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Crystal Shell — Installer
# Usage:
#   ./install.sh            # System install (recommended for end users)
#   ./install.sh --dev      # Developer install (run UI from source)
# ─────────────────────────────────────────────────────────────────────────────

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# When run via `sudo bash install.sh`, $HOME is /root. Use SUDO_USER's home instead.
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
CONFIG_DIR="${REAL_HOME}/.config/crystal-shell"

# ── Mode selection ────────────────────────────────────────────────────────────
MODE="system"
for arg in "$@"; do
    case "$arg" in
        --dev)  MODE="dev" ;;
        --help) echo "Usage: $0 [--system|--dev]"; exit 0 ;;
    esac
done

echo ""
echo "  Crystal Shell Installer"
echo "  Mode: $MODE"
echo "  Repo: $REPO_DIR"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. System dependencies
# ─────────────────────────────────────────────────────────────────────────────
echo "[1/7] Installing system dependencies..."
sudo pacman -Sy --needed --noconfirm \
    base-devel glib2-devel cmake meson ninja gobject-introspection vala \
    gtk3 gtk4 gtk4-layer-shell libadwaita libpeas-2 \
    libpulse networkmanager bluez-libs upower libnotify \
    intltool scdoc brightnessctl pamixer hyprpicker \
    jq slurp grim wl-clipboard mesa pam \
    git nodejs npm gjs go \
    accountsservice sddm pavucontrol rust cargo \
    hyprland hyprlock hypridle uwsm \
    kitty nautilus dolphin thunar \
    polkit-gnome \
    xdg-desktop-portal-gtk xdg-desktop-portal-hyprland \
    ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji \
    xfce4-settings hyprlauncher kvantum kvantum-qt5 qt5ct qt6ct awww lz4

# ─────────────────────────────────────────────────────────────────────────────
# 2. Build & install Astal dependencies
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/7] Building Astal service libraries..."

echo "  Building appmenu-glib-translator..."
mkdir -p /tmp/astal-deps && cd /tmp/astal-deps
[ ! -d "vala-panel-appmenu" ] && git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git
cd vala-panel-appmenu/subprojects/appmenu-glib-translator
rm -rf build && meson setup build --prefix=/usr && sudo meson install -C build

echo "  Building Astal components..."
mkdir -p /tmp/astal-build && cd /tmp/astal-build
[ ! -d "astal" ] && git clone https://github.com/aylur/astal.git
cd astal

for comp in \
    "lib/astal/io" "lib/astal/gtk3" "lib/astal/gtk4" \
    "lib/apps" "lib/hyprland" "lib/mpris" "lib/network" \
    "lib/battery" "lib/notifd" "lib/bluetooth" "lib/tray" \
    "lang/gjs"
do
    echo "  Building $comp..."
    pushd "$comp" > /dev/null
    rm -rf build && meson setup build --prefix=/usr && sudo meson install -C build
    popd > /dev/null
done

# ─────────────────────────────────────────────────────────────────────────────
# 3. Configure GObject Introspection
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/7] Configuring GObject Introspection..."
sudo ldconfig
if ! grep -q "GI_TYPELIB_PATH" /etc/environment 2>/dev/null; then
    echo 'GI_TYPELIB_PATH="/usr/lib/girepository-1.0"' | sudo tee -a /etc/environment
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Build & install AGS CLI
# ─────────────────────────────────────────────────────────────────────────────
echo "[4/7] Building AGS CLI..."
mkdir -p /tmp/ags-build && cd /tmp/ags-build
[ ! -d "ags" ] && git clone https://github.com/aylur/ags.git
cd ags
rm -rf build && npm install && meson setup build --prefix=/usr && sudo meson install -C build

# ─────────────────────────────────────────────────────────────────────────────
# 5. Build the Crystal Shell UI bundle
# ─────────────────────────────────────────────────────────────────────────────
echo "[5/7] Building Crystal Shell UI..."
cd "$REPO_DIR/ui/ags-v3"
npm install
npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css

if [ "$MODE" = "system" ]; then
    echo "  Bundling..."
    mkdir -p build
    ags bundle app.ts build/crystal-shell
    echo "  [OK] Bundle: $REPO_DIR/ui/ags-v3/build/crystal-shell"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Install system files
# ─────────────────────────────────────────────────────────────────────────────
echo "[6/7] Installing system files..."

# Hyprland config
sudo mkdir -p /usr/share/crystal-shell/config/hypr
sudo cp -r "$REPO_DIR/config/hypr/." /usr/share/crystal-shell/config/hypr/

# UI bundle + style
sudo mkdir -p /usr/share/crystal-shell/ui/ags-v3/build
if [ "$MODE" = "system" ]; then
    sudo cp "$REPO_DIR/ui/ags-v3/build/crystal-shell" /usr/share/crystal-shell/ui/ags-v3/build/
fi
sudo cp "$REPO_DIR/ui/ags-v3/style.css" /usr/share/crystal-shell/ui/ags-v3/

# Session wrapper scripts
sudo cp "$REPO_DIR/scripts/crystal-shell"    /usr/bin/crystal-shell
sudo cp "$REPO_DIR/scripts/crystal-shell-ui" /usr/bin/crystal-shell-ui
sudo chmod +x /usr/bin/crystal-shell /usr/bin/crystal-shell-ui

# Wayland session entry
sudo mkdir -p /usr/share/wayland-sessions
cat <<'EOF' | sudo tee /usr/share/wayland-sessions/crystal-shell.desktop > /dev/null
[Desktop Entry]
Name=Crystal Shell
Comment=A fluid, glassmorphic desktop environment based on Hyprland & AGS
Exec=/usr/bin/crystal-shell
Type=Application
DesktopNames=Hyprland
EOF

# Application entries
sudo mkdir -p /usr/share/applications
sudo cp "$REPO_DIR/config/applications/"*.desktop /usr/share/applications/
sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true

# XDG portals
sudo mkdir -p /usr/share/xdg-desktop-portal/portals
cat <<'EOF' | sudo tee /usr/share/xdg-desktop-portal/portals/crystal-shell.conf > /dev/null
[preferred]
default=gtk
org.freedesktop.impl.portal.ScreenCast=hyprland
org.freedesktop.impl.portal.Screenshot=hyprland
EOF

# ─────────────────────────────────────────────────────────────────────────────
# 7. Initialize user configuration (first run only, never overwrites)
# ─────────────────────────────────────────────────────────────────────────────
echo "[7/7] Initializing user configuration..."
mkdir -p "$CONFIG_DIR"
chown "$REAL_USER" "$CONFIG_DIR"

# Dev mode marker
if [ "$MODE" = "dev" ]; then
    echo "$REPO_DIR" > "$CONFIG_DIR/.dev"
    chown "$REAL_USER" "$CONFIG_DIR/.dev"
    echo "  [Dev] crystal-shell-ui will run from: $REPO_DIR"
else
    rm -f "$CONFIG_DIR/.dev"
fi

# Default JSON configs (never overwrite user's existing files)
for f in appearance.json widgets.json cc_layout.json region.json; do
    if [ -f "$REPO_DIR/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
        cp "$REPO_DIR/$f" "$CONFIG_DIR/$f"
        echo "  [Init] $CONFIG_DIR/$f"
    fi
done

# Hyprland user overrides (created once, never overwritten)
if [ ! -f "$CONFIG_DIR/hyprland-user.conf" ]; then
    cat > "$CONFIG_DIR/hyprland-user.conf" <<'HYPR'
# ── hyprland-user.conf ──────────────────────────────────────────────────────
# Your personal Hyprland overrides. Crystal Shell updates will never touch this.
# Add keyboard layout, monitor setup, startup apps, custom keybinds, etc.
#
# Examples:
#   input {
#       kb_layout = es    # Change to your layout (us, uk, es, latam...)
#   }
#   monitor = HDMI-A-1, 1920x1080@60, 0x0, 1
#   bind = SUPER, F1, exec, my-app
#   exec-once = my-custom-daemon
#
# NVIDIA users — uncomment if needed:
#   env = LIBVA_DRIVER_NAME,nvidia
#   env = GBM_BACKEND,nvidia-drm
#   env = __GLX_VENDOR_LIBRARY_NAME,nvidia
#   cursor { no_hardware_cursors = true }
# ─────────────────────────────────────────────────────────────────────────────
HYPR
    echo "  [Init] $CONFIG_DIR/hyprland-user.conf"
fi

# Crystal Shell generated config (Hyprland settings from UI)
if [ ! -f "$CONFIG_DIR/crystal-settings.conf" ]; then
    touch "$CONFIG_DIR/crystal-settings.conf"
    echo "  [Init] $CONFIG_DIR/crystal-settings.conf"
fi

# ── SDDM ──────────────────────────────────────────────────────────────────────
echo "  Enabling SDDM..."
sudo systemctl enable sddm 2>/dev/null || true

# ── Audio services ────────────────────────────────────────────────────────────
echo "  Enabling audio services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse 2>/dev/null || true

echo ""
echo "  ✓ Installation complete ($MODE mode)"
if [ "$MODE" = "dev" ]; then
    echo "  Dev: crystal-shell-ui will run from source at $REPO_DIR"
    echo "  To exit dev mode: rm $CONFIG_DIR/.dev && install.sh"
fi
echo "  Select 'Crystal Shell' at the login screen."
echo ""
