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
# System environment detection
# Reads values the user already set during Arch installation — never asks.
# ─────────────────────────────────────────────────────────────────────────────

# Keyboard layout ─────────────────────────────────────────────────────────────
# vconsole keymaps mostly match X11/Wayland names, but a few differ.
_vconsole_to_xkb() {
    case "$1" in
        uk)          echo "gb"    ;;  # British: vconsole=uk, XKB=gb
        us-acentos)  echo "us"    ;;  # Latin US variant → plain us
        br-abnt2)    echo "br"    ;;
        *)           echo "$1"    ;;  # All others match directly
    esac
}

SYS_KB_LAYOUT="us"
if [ -f /etc/vconsole.conf ]; then
    _keymap=$(grep -E "^KEYMAP=" /etc/vconsole.conf | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_keymap" ] && SYS_KB_LAYOUT=$(_vconsole_to_xkb "$_keymap")
fi

# Timezone ────────────────────────────────────────────────────────────────────
SYS_TIMEZONE="UTC"
if [ -L /etc/localtime ]; then
    _tz=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
    [ -n "$_tz" ] && SYS_TIMEZONE="$_tz"
fi

# Locale ──────────────────────────────────────────────────────────────────────
SYS_LOCALE="en_US"
if [ -f /etc/locale.conf ]; then
    _lang=$(grep -E "^LANG=" /etc/locale.conf | head -1 | cut -d= -f2 | cut -d. -f1 | tr -d '"' | tr -d "'")
    [ -n "$_lang" ] && SYS_LOCALE="$_lang"
fi

echo "  Detected: layout=$SYS_KB_LAYOUT  timezone=$SYS_TIMEZONE  locale=$SYS_LOCALE"
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
    accountsservice greetd pavucontrol rust cargo \
    hyprland hypridle uwsm \
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
    "lib/greet" \
    "lib/auth" \
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
    echo "  Bundling shell UI..."
    mkdir -p build
    ags bundle app.ts build/crystal-shell
    echo "  [OK] Bundle: $REPO_DIR/ui/ags-v3/build/crystal-shell"
fi

echo "  Building greeter..."
# Use ags-v3's sass installation for SCSS compilation
cd "$REPO_DIR/ui/ags-v3"
npx sass --no-charset ../greeter/style.scss ../greeter/style.css && sed -i '/@charset/d' ../greeter/style.css
cd "$REPO_DIR/ui/greeter"
if [ "$MODE" = "system" ]; then
    mkdir -p build
    ags bundle app.ts build/crystal-greeter
    echo "  [OK] Greeter bundle: $REPO_DIR/ui/greeter/build/crystal-greeter"
fi

echo "  Building lockscreen..."
cd "$REPO_DIR/ui/lockscreen"
if [ "$MODE" = "system" ]; then
    mkdir -p build
    ags bundle app.ts build/crystal-lock
    echo "  [OK] Lockscreen bundle: $REPO_DIR/ui/lockscreen/build/crystal-lock"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Install system files
# ─────────────────────────────────────────────────────────────────────────────
echo "[6/7] Installing system files..."

# Version file
sudo mkdir -p /usr/share/crystal-shell
sudo cp "$REPO_DIR/VERSION" /usr/share/crystal-shell/VERSION

# Hyprland config
sudo mkdir -p /usr/share/crystal-shell/config/hypr
sudo cp -r "$REPO_DIR/config/hypr/." /usr/share/crystal-shell/config/hypr/

# Default wallpaper
if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper.png" ]; then
    sudo cp "$REPO_DIR/defaults/wallpaper/wallpaper.png" /usr/share/crystal-shell/wallpaper.png
fi

# Shell UI bundle + style
sudo mkdir -p /usr/share/crystal-shell/ui/ags-v3/build
if [ "$MODE" = "system" ]; then
    sudo cp "$REPO_DIR/ui/ags-v3/build/crystal-shell" /usr/share/crystal-shell/ui/ags-v3/build/
fi
sudo cp "$REPO_DIR/ui/ags-v3/style.css" /usr/share/crystal-shell/ui/ags-v3/

# Greeter bundle + style
sudo mkdir -p /usr/share/crystal-shell/ui/greeter/build
if [ "$MODE" = "system" ]; then
    sudo cp "$REPO_DIR/ui/greeter/build/crystal-greeter" /usr/share/crystal-shell/ui/greeter/build/
fi
sudo cp "$REPO_DIR/ui/greeter/style.css" /usr/share/crystal-shell/ui/greeter/

# Lockscreen bundle (shares greeter's style.css)
sudo mkdir -p /usr/share/crystal-shell/ui/lockscreen/build
if [ "$MODE" = "system" ]; then
    sudo cp "$REPO_DIR/ui/lockscreen/build/crystal-lock" /usr/share/crystal-shell/ui/lockscreen/build/
fi

# Session wrapper scripts
sudo cp "$REPO_DIR/scripts/crystal-shell"    /usr/bin/crystal-shell
sudo cp "$REPO_DIR/scripts/crystal-shell-ui" /usr/bin/crystal-shell-ui
sudo cp "$REPO_DIR/scripts/crystal-greeter"  /usr/bin/crystal-greeter
sudo cp "$REPO_DIR/scripts/crystal-lock"     /usr/bin/crystal-lock
sudo chmod +x /usr/bin/crystal-shell /usr/bin/crystal-shell-ui /usr/bin/crystal-greeter /usr/bin/crystal-lock

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
for f in appearance.json widgets.json cc_layout.json; do
    if [ -f "$REPO_DIR/defaults/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
        cp "$REPO_DIR/defaults/$f" "$CONFIG_DIR/$f"
        chown "$REAL_USER" "$CONFIG_DIR/$f"
        echo "  [Init] $CONFIG_DIR/$f"
    fi
done

# region.json — generated with detected timezone (not copied from defaults)
if [ ! -f "$CONFIG_DIR/region.json" ]; then
    cat > "$CONFIG_DIR/region.json" <<JSON
{
  "timeFormat": "24h",
  "dateFormat": "long",
  "timezone": "$SYS_TIMEZONE",
  "showSeconds": false
}
JSON
    chown "$REAL_USER" "$CONFIG_DIR/region.json"
    echo "  [Init] $CONFIG_DIR/region.json (timezone=$SYS_TIMEZONE)"
fi

# Hyprland user overrides (created once, never overwritten)
if [ ! -f "$CONFIG_DIR/hyprland-user.conf" ]; then
    cat > "$CONFIG_DIR/hyprland-user.conf" <<HYPR
# ── hyprland-user.conf ──────────────────────────────────────────────────────
# Your personal Hyprland overrides. Crystal Shell updates will never touch this.
# Add monitor setup, startup apps, custom keybinds, etc.
#
# Note: environment variables go in ~/.config/uwsm/env (toolkit/NVIDIA)
# or ~/.config/uwsm/env-hyprland (HYPR* / AQ_* variables) — not here.
# ─────────────────────────────────────────────────────────────────────────────

input {
    kb_layout = $SYS_KB_LAYOUT
}
HYPR
    echo "  [Init] $CONFIG_DIR/hyprland-user.conf"
fi

# Crystal Shell generated config (Hyprland settings from UI)
if [ ! -f "$CONFIG_DIR/crystal-settings.conf" ]; then
    touch "$CONFIG_DIR/crystal-settings.conf"
    echo "  [Init] $CONFIG_DIR/crystal-settings.conf"
fi

# Hypridle config
# Dev mode:    symlink directly to repo so edits take effect immediately
# System mode: copy to $CONFIG_DIR once (never overwritten), symlink from there
mkdir -p "${REAL_HOME}/.config/hypr"

for daemon in hypridle; do
    LINK="${REAL_HOME}/.config/hypr/${daemon}.conf"
    if [ "$MODE" = "dev" ]; then
        TARGET="$REPO_DIR/config/hypr/${daemon}.conf"
    else
        TARGET="$CONFIG_DIR/${daemon}.conf"
        if [ ! -f "$TARGET" ]; then
            cp "$REPO_DIR/config/hypr/${daemon}.conf" "$TARGET"
            chown "$REAL_USER" "$TARGET"
            echo "  [Init] $TARGET"
        fi
    fi
    # Always (re)create the symlink so it points to the right target for the current mode
    ln -sf "$TARGET" "$LINK"
    echo "  [Symlink] $LINK -> $TARGET"
done

# uwsm environment files (created once, never overwritten)
UWSM_DIR="${REAL_HOME}/.config/uwsm"
mkdir -p "$UWSM_DIR"
chown "$REAL_USER" "$UWSM_DIR"
for f in env env-hyprland; do
    if [ ! -f "$UWSM_DIR/$f" ]; then
        cp "$REPO_DIR/defaults/uwsm/$f" "$UWSM_DIR/$f"
        chown "$REAL_USER" "$UWSM_DIR/$f"
        echo "  [Init] $UWSM_DIR/$f"
    fi
done

# ── Display manager ───────────────────────────────────────────────────────────
# Only install and enable greetd if no other display manager is already active.
# If the user already has sddm/gdm/lightdm/etc. enabled we leave it untouched.
_detect_dm() {
    for dm in sddm gdm lightdm lxdm xdm slim ly greetd; do
        if systemctl is-enabled "$dm" 2>/dev/null | grep -qE "^enabled"; then
            echo "$dm"; return 0
        fi
    done
    echo "none"
}

ACTIVE_DM=$(_detect_dm)
if [ "$ACTIVE_DM" = "none" ]; then
    echo "  No display manager detected — installing greetd..."

    # Install greetd config files (inject detected keyboard layout)
    sudo mkdir -p /etc/greetd
    sudo cp "$REPO_DIR/config/greetd/config.toml" /etc/greetd/config.toml
    sudo sed "s/kb_layout = us/kb_layout = $SYS_KB_LAYOUT/" \
        "$REPO_DIR/config/greetd/hyprland-greeter.conf" \
        | sudo tee /etc/greetd/hyprland-greeter.conf > /dev/null
    sudo chmod 644 /etc/greetd/config.toml /etc/greetd/hyprland-greeter.conf

    # Symlink greeter Hyprland config to the greeter user's default location
    # so start-hyprland finds it without needing a -c flag
    GREETER_HOME=$(getent passwd greeter | cut -d: -f6)
    if [ -n "$GREETER_HOME" ]; then
        sudo mkdir -p "$GREETER_HOME/.config/hypr"
        sudo ln -sf /etc/greetd/hyprland-greeter.conf "$GREETER_HOME/.config/hypr/hyprland.conf"
        sudo chown -R greeter:greeter "$GREETER_HOME/.config"
        echo "  [OK] Greeter Hyprland config symlinked to $GREETER_HOME/.config/hypr/hyprland.conf"
    fi

    sudo systemctl enable greetd
    echo "  [OK] greetd enabled."
else
    echo "  Display manager '$ACTIVE_DM' already enabled — skipping greetd setup."
fi

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
