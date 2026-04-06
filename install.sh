#!/bin/bash
# Crystal Shell - Provisioning Script
# Designed for EndeavourOS / Arch Linux

set -e

echo "Starting Crystal Shell installation (Arch Linux)..."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
INSTALL_DIR="$HOME/.config/crystal-shell"

if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
    echo "=========================================="
    echo "Crystal Shell Installation"
    echo "=========================================="
    echo "Choose installation mode for $INSTALL_DIR:"
    echo "1) Normal install  (file copy  - recommended for users)"
    echo "2) Developer install (symlink  - recommended for contributors)"

    INSTALL_MODE="1"
    read -p ">> Select [1/2] (default: 1): " -t 30 USER_INPUT
    INSTALL_MODE=${USER_INPUT:-1}

    if [ "$INSTALL_MODE" = "2" ]; then
        echo "Creating development symlink..."
        # Replace any existing directory with a symlink
        if [ -d "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
            echo "[WARN] Existing directory found at $INSTALL_DIR. Replacing with symlink..."
            rm -rf "$INSTALL_DIR"
        fi
        ln -sfn "$REPO_DIR" "$INSTALL_DIR"
    else
        echo "Copying files..."
        mkdir -p "$INSTALL_DIR"
        cp -rT "$REPO_DIR" "$INSTALL_DIR"
    fi
fi

# 1. System Dependencies
echo "Installing system dependencies via pacman..."
sudo pacman -Sy --needed --noconfirm \
    base-devel \
    glib2-devel \
    cmake \
    meson \
    ninja \
    gobject-introspection \
    vala \
    gtk3 \
    gtk4 \
    gtk4-layer-shell \
    libadwaita \
    libpeas-2 \
    libpulse \
    networkmanager \
    bluez-libs \
    upower \
    libnotify \
    intltool \
    scdoc \
    brightnessctl \
    pamixer \
    hyprpicker \
    jq \
    slurp \
    grim \
    wl-clipboard \
    mesa \
    pam \
    git \
    nodejs \
    npm \
    gjs \
    go \
    accountsservice \
    sddm \
    pavucontrol \
    rust \
    cargo \
    hyprland \
    hyprlock \
    hypridle \
    kitty \
    thunar \
    nautilus \
    dolphin \
    polkit-gnome \
    xdg-desktop-portal-gtk \
    xdg-desktop-portal-hyprland \
    ttf-jetbrains-mono-nerd \
    noto-fonts-emoji \
    xfce4-settings \
    hyprlauncher \
    kvantum \
    kvantum-qt5 \
    qt5ct \
    qt6ct \
    awww \
    lz4

# 2. Build & Install Dependencies (Vala Panel Appmenu)
# Required for AstalTray
echo "Building appmenu-glib-translator..."
mkdir -p /tmp/astal-deps
cd /tmp/astal-deps
if [ ! -d "vala-panel-appmenu" ]; then
    git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git
fi
cd vala-panel-appmenu/subprojects/appmenu-glib-translator
rm -rf build
meson setup build --prefix=/usr
sudo meson install -C build

# 3. Build & Install Astal Libraries
echo "Building Astal service libraries..."
mkdir -p /tmp/astal-build
cd /tmp/astal-build
if [ ! -d "astal" ]; then
    git clone https://github.com/aylur/astal.git
fi
cd astal

COMPONENTS=(
    "lib/astal/io"
    "lib/astal/gtk3"
    "lib/astal/gtk4"
    "lib/apps"
    "lib/hyprland"
    "lib/mpris"
    "lib/network"
    "lib/battery"
    "lib/notifd"
    "lib/bluetooth"
    "lib/tray"
    "lang/gjs"
)

for comp in "${COMPONENTS[@]}"; do
    echo "Building $comp..."
    pushd "$comp"
    rm -rf build
    meson setup build --prefix=/usr
    sudo meson install -C build
    popd
done

# 4. Configure GObject Introspection paths and linker cache
echo "Configuring GI_TYPELIB_PATH and library cache..."
TYPELIB_PATH="/usr/lib/girepository-1.0"

echo "Refreshing shared library cache..."
sudo ldconfig

if ! grep -q "GI_TYPELIB_PATH" /etc/environment; then
    echo "GI_TYPELIB_PATH=\"$TYPELIB_PATH\"" | sudo tee -a /etc/environment
else
    sudo sed -i "s|GI_TYPELIB_PATH=.*|GI_TYPELIB_PATH=\"$TYPELIB_PATH\"|g" /etc/environment
fi

# 5. Build & Install AGS CLI
echo "Building AGS v3 CLI..."
mkdir -p /tmp/ags-build
cd /tmp/ags-build
if [ ! -d "ags" ]; then
    git clone https://github.com/aylur/ags.git
fi
cd ags
rm -rf build
npm install
meson setup build --prefix=/usr
sudo meson install -C build

# 6. UI Setup
echo "Setting up AGS UI..."
if [ -d "$INSTALL_DIR/ui/ags-v3" ]; then
    cd "$INSTALL_DIR/ui/ags-v3"

    if [ "$INSTALL_MODE" = "2" ]; then
        # Dev mode: install npm deps for IDE support (TypeScript types, sass)
        echo "Installing npm dev dependencies..."
        npm install
        echo "Compiling SCSS..."
        npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
    else
        # User mode: style.css is pre-compiled in the repo
        echo "[INFO] Using pre-compiled style.css"
    fi

    # Bundle into standalone binary
    echo "Bundling Crystal Shell..."
    mkdir -p build
    ags bundle app.ts build/crystal-shell
    echo "[OK] Bundle created at $INSTALL_DIR/ui/ags-v3/build/crystal-shell"
else
    echo "[WARN] UI directory not found at $INSTALL_DIR/ui/ags-v3, skipping."
fi

# 7. Enable Audio Services
echo "Enabling audio services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse

# 8. Configure System Session (SDDM & Hyprland)
echo "Configuring session..."

echo "Enabling SDDM display manager..."
sudo systemctl enable sddm

# Link Hyprland configs
echo "Linking Hyprland configuration..."
mkdir -p "$HOME/.config/hypr"

for conf in hyprland.conf hyprlock.conf hypridle.conf; do
    if [ -f "$HOME/.config/hypr/$conf" ] && [ ! -L "$HOME/.config/hypr/$conf" ]; then
        mv "$HOME/.config/hypr/$conf" "$HOME/.config/hypr/$conf.bak"
    fi
    ln -sf "$INSTALL_DIR/config/hypr/$conf" "$HOME/.config/hypr/$conf"
done

# User overrides file — never overwritten by updates
USER_CONF="$HOME/.config/hypr/hyprland-user.conf"
if [ ! -f "$USER_CONF" ]; then
    cat > "$USER_CONF" <<'EOF'
# ── hyprland-user.conf ──────────────────────────────────────────────────────
# This file is yours. Crystal Shell updates will never touch it.
# Add your personal customizations here: keyboard layout, monitors, startup
# apps, keybinds, etc.
#
# Examples:
#   input {
#       kb_layout = es     # Change to your keyboard layout (us, uk, latam...)
#   }
#   monitor = HDMI-A-1, 1920x1080@60, 0x0, 1
#   bind = SUPER, F1, exec, my-app
#   exec-once = my-custom-daemon
#
# NVIDIA users — uncomment the block below if you have an NVIDIA GPU:
#   env = LIBVA_DRIVER_NAME,nvidia
#   env = XDG_SESSION_TYPE,wayland
#   env = GBM_BACKEND,nvidia-drm
#   env = __GLX_VENDOR_LIBRARY_NAME,nvidia
#   cursor {
#       no_hardware_cursors = true
#   }
# ─────────────────────────────────────────────────────────────────────────────
EOF
    echo "[OK] Created user config: $USER_CONF"
else
    echo "[INFO] User config already exists, keeping: $USER_CONF"
fi

# 9. Configure XDG Portals
echo "Configuring XDG desktop portals..."
mkdir -p "$HOME/.config/xdg-desktop-portal"
cat > "$HOME/.config/xdg-desktop-portal/portals.conf" <<'EOF'
[preferred]
default=gtk
org.freedesktop.impl.portal.ScreenCast=hyprland
org.freedesktop.impl.portal.Screenshot=hyprland
EOF

# 10. Desktop Session Entry
echo "Creating Crystal Shell desktop session entry..."
sudo mkdir -p /usr/share/wayland-sessions
cat <<'EOF' | sudo tee /usr/share/wayland-sessions/crystal-shell.desktop > /dev/null
[Desktop Entry]
Name=Crystal Shell
Comment=A fluid, glassmorphic desktop environment based on Hyprland & AGS
Exec=Hyprland
Type=Application
DesktopNames=Hyprland
EOF

# 11. Install Application Entries
echo "Installing application entries..."
mkdir -p "$HOME/.local/share/applications"
if [ "$INSTALL_MODE" = "2" ]; then
    for f in "$INSTALL_DIR/config/applications/"*.desktop; do
        ln -sf "$f" "$HOME/.local/share/applications/$(basename "$f")"
    done
else
    cp "$INSTALL_DIR/config/applications/"*.desktop "$HOME/.local/share/applications/"
fi
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true

echo ""
echo "[OK] Installation complete."
echo "Restart your session (or run 'sudo systemctl start sddm') and select 'Crystal Shell' from the login screen."
