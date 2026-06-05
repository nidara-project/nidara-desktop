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

# ── Pinned upstream versions ──────────────────────────────────────────────────
# The Astal/AGS/appmenu libraries are built from source. Building against an
# upstream's moving HEAD has bitten us before (e.g. the GJS 1.88 break of
# `ags request`), so each source build is pinned to a known-good revision.
#
# MAINTAINERS: bump these and re-test a clean install before tagging a release.
# Astal has no git tags, so it is pinned by commit SHA.
ASTAL_REF="d8738f97ed01f4d87f668df35fa7bbad795c9e49"   # github.com/aylur/astal @ main
AGS_REF="v3.1.2"                                        # github.com/aylur/ags release tag
APPMENU_REF="aea4ea398b7c75494f23f5e5bdb4f495d615059f"  # gitlab vala-panel-appmenu @ master

# Build dir for the source-built dependency packages (Astal libs, AGS, appmenu).
PKG_CACHE="${REAL_HOME}/.cache/crystal-shell/pkgbuild"

# Run a command as the unprivileged user. makepkg refuses to run as root, so when
# the installer itself is invoked via `sudo` we drop back to $REAL_USER (with -H so
# npm/go caches land in the user's home, not /root).
run_user() {
    if [ "$(id -u)" -eq 0 ]; then sudo -u "$REAL_USER" -H "$@"; else "$@"; fi
}

# makepkg the PKGBUILD in dir $1, then hand the result to pacman. We --overwrite
# because earlier Crystal Shell releases `meson install`-ed these libs straight into
# /usr as UNTRACKED files (invisible to `pacman -Qo`, unupgradable, unremovable —
# the exact blind spot that hid a stale, crashing appmenu-glib-translator). This
# transition gives those paths to pacman; from here they upgrade/remove cleanly.
build_install_pkg() {
    local dir="$1"
    mkdir -p "$PKG_CACHE/src"
    chown -R "$REAL_USER" "$dir" "$PKG_CACHE/src" 2>/dev/null || true
    # -f rebuild, --nodeps (install order is managed below), --skipinteg (git sources)
    run_user bash -c "cd '$dir' && SRCDEST='$PKG_CACHE/src' makepkg -f --noconfirm --nodeps --skipinteg --noprogressbar"
    local pkgfile
    pkgfile="$(ls -t "$dir"/*.pkg.tar.* 2>/dev/null | head -1)"
    [ -n "$pkgfile" ] || { echo "  [ERR] makepkg produced no package in $dir" >&2; exit 1; }
    sudo pacman -U --noconfirm --overwrite '*' "$pkgfile"
}

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
# -Syu, never bare -Sy: syncing the DBs without a full upgrade leaves a partial-upgrade
# state, and the next --needed install pulls a new lib (e.g. aquamarine) whose soname no
# longer matches already-installed packages (e.g. hyprtoolkit) → transaction fails.
sudo pacman -Syu --needed --noconfirm \
    base-devel glib2-devel cmake meson ninja gobject-introspection vala \
    gtk3 gtk4 gtk4-layer-shell libpeas-2 \
    libpulse networkmanager bluez-libs upower libnotify \
    intltool scdoc brightnessctl pamixer hyprpicker \
    jq slurp grim wf-recorder wl-clipboard cliphist mesa pam \
    git nodejs npm gjs go \
    accountsservice greetd pavucontrol rust cargo \
    hyprland hypridle hyprsunset uwsm power-profiles-daemon \
    kitty nautilus \
    polkit-gnome \
    xdg-desktop-portal-gtk xdg-desktop-portal-hyprland \
    ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji \
    hyprlauncher awww lz4

# ─────────────────────────────────────────────────────────────────────────────
# 2. Build & install Astal dependencies
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/7] Building & packaging Astal service libraries..."
mkdir -p "$PKG_CACHE/src"
chown -R "$REAL_USER" "$PKG_CACHE" 2>/dev/null || true

# ── appmenu-glib-translator (build/runtime dep of libastal-tray) ──────────────
# Build this FIRST: libastal-tray links it. Pinned by $APPMENU_REF.
echo "  Packaging appmenu-glib-translator..."
appmenu_dir="$PKG_CACHE/appmenu-glib-translator"
mkdir -p "$appmenu_dir"
cat > "$appmenu_dir/PKGBUILD" <<PKGB
pkgname=appmenu-glib-translator
pkgver=25.04.r${APPMENU_REF:0:7}
_commit=$APPMENU_REF
PKGB
cat >> "$appmenu_dir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="DBusMenu→GMenuModel translator (pinned for Crystal Shell)"
arch=(x86_64)
url="https://gitlab.com/vala-panel-project/vala-panel-appmenu"
license=(LGPL3)
depends=()
makedepends=(meson ninja vala gobject-introspection git glib2-devel)
options=(!debug)
source=("vala-panel-appmenu::git+https://gitlab.com/vala-panel-project/vala-panel-appmenu.git#commit=$_commit")
sha256sums=('SKIP')
build() {
  cd "$srcdir/vala-panel-appmenu/subprojects/appmenu-glib-translator"
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/vala-panel-appmenu/subprojects/appmenu-glib-translator"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
build_install_pkg "$appmenu_dir"

# ── Astal libraries ───────────────────────────────────────────────────────────
# Astal has no root meson.build: each lib is built standalone and finds the others
# via pkg-config, so they MUST be built+installed in dependency order (io first).
# One package per lib (mirrors the AUR libastal-* layout) keeps each individually
# trackable. The astal source is cloned once into the shared SRCDEST and reused.
# depends=() is intentional: every runtime dep is already pulled in by step 1's
# `pacman -S`, and empty deps keep this first packaging pass from failing on
# transient resolution. (crystal-repo can tighten these later — see packaging/README.)
echo "  Packaging Astal components (in dependency order)..."
astal_pkgs=(
    "lib/astal/io|libastal-io"
    "lib/quarrel|astal-quarrel"
    "lib/astal/gtk3|libastal-gtk3"
    "lib/astal/gtk4|libastal-gtk4"
    "lib/apps|libastal-apps"
    "lib/hyprland|libastal-hyprland"
    "lib/mpris|libastal-mpris"
    "lib/network|libastal-network"
    "lib/battery|libastal-battery"
    "lib/notifd|libastal-notifd"
    "lib/bluetooth|libastal-bluetooth"
    "lib/tray|libastal-tray"
    "lib/greet|libastal-greet"
    "lib/auth|libastal-auth"
    "lang/gjs|astal-gjs"
)
for entry in "${astal_pkgs[@]}"; do
    subdir="${entry%%|*}"
    name="${entry##*|}"
    pdir="$PKG_CACHE/$name"
    mkdir -p "$pdir"
    cat > "$pdir/PKGBUILD" <<PKGB
pkgname=$name
pkgver=0.1.0.r${ASTAL_REF:0:7}
_subdir=$subdir
_commit=$ASTAL_REF
PKGB
    cat >> "$pdir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="Astal library ($_subdir), pinned for Crystal Shell"
arch=(x86_64)
url="https://github.com/Aylur/astal"
license=(LGPL3)
depends=()
makedepends=(meson ninja vala gobject-introspection git glib2-devel)
options=(!debug)
source=("astal::git+https://github.com/Aylur/astal.git#commit=$_commit")
sha256sums=('SKIP')
build() {
  cd "$srcdir/astal/$_subdir"
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/astal/$_subdir"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
    echo "  → $name ($subdir)"
    build_install_pkg "$pdir"
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
echo "[4/7] Building & packaging AGS CLI..."
ags_dir="$PKG_CACHE/aylurs-gtk-shell"
mkdir -p "$ags_dir"
cat > "$ags_dir/PKGBUILD" <<PKGB
pkgname=aylurs-gtk-shell
pkgver=${AGS_REF#v}
_ref=$AGS_REF
PKGB
cat >> "$ags_dir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="Aylur's GTK Shell (ags) CLI, pinned for Crystal Shell"
arch=(x86_64)
url="https://github.com/Aylur/ags"
license=(GPL3)
depends=(astal-gjs gjs)
makedepends=(meson ninja vala gobject-introspection git nodejs npm go glib2-devel)
options=(!debug)
source=("ags::git+https://github.com/Aylur/ags.git#tag=$_ref")
sha256sums=('SKIP')
build() {
  cd "$srcdir/ags"
  npm install
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/ags"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
build_install_pkg "$ags_dir"

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
if [ "$MODE" = "dev" ]; then
    sudo ln -sf "$REPO_DIR/config/hypr/hyprland.lua" /usr/share/crystal-shell/config/hypr/hyprland.lua
    sudo cp "$REPO_DIR/config/hypr/hypridle.conf" /usr/share/crystal-shell/config/hypr/hypridle.conf
else
    sudo cp -r "$REPO_DIR/config/hypr/." /usr/share/crystal-shell/config/hypr/
fi

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
# Static assets (icons, svgs) — resolved via SHELL_ROOT in prod (core/Paths.ts).
sudo rm -rf /usr/share/crystal-shell/ui/ags-v3/assets
sudo cp -r "$REPO_DIR/ui/ags-v3/assets" /usr/share/crystal-shell/ui/ags-v3/

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
sudo cp "$REPO_DIR/scripts/crystal-shell"     /usr/bin/crystal-shell
sudo cp "$REPO_DIR/scripts/crystal-shell-ui"  /usr/bin/crystal-shell-ui
sudo cp "$REPO_DIR/scripts/crystal-greeter"   /usr/bin/crystal-greeter
sudo cp "$REPO_DIR/scripts/crystal-lock"      /usr/bin/crystal-lock
sudo cp "$REPO_DIR/scripts/crystal-game-mode" /usr/bin/crystal-game-mode
sudo chmod +x /usr/bin/crystal-shell /usr/bin/crystal-shell-ui /usr/bin/crystal-greeter /usr/bin/crystal-lock /usr/bin/crystal-game-mode

# systemd user unit — the shell respawns on crash instead of leaving a bare
# compositor (see scripts/crystal-shell.service). Enabled below.
sudo mkdir -p /usr/lib/systemd/user
sudo cp "$REPO_DIR/scripts/crystal-shell.service" /usr/lib/systemd/user/crystal-shell.service

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
if [ ! -f "$CONFIG_DIR/hyprland-user.lua" ]; then
    cat > "$CONFIG_DIR/hyprland-user.lua" <<LUA
-- ── hyprland-user.lua ────────────────────────────────────────────────────────
-- Your personal Hyprland overrides. Crystal Shell updates will never touch this.
-- Add monitor setup, startup apps, custom keybinds, etc.
--
-- Note: environment variables go in ~/.config/uwsm/env (toolkit/NVIDIA)
-- or ~/.config/uwsm/env-hyprland (HYPR* / AQ_* variables) — not here.
-- ─────────────────────────────────────────────────────────────────────────────

-- @autostart start
hl.on("hyprland.start", function()
end)
-- @autostart end
LUA
    chown "$REAL_USER" "$CONFIG_DIR/hyprland-user.lua"
    echo "  [Init] $CONFIG_DIR/hyprland-user.lua"
fi

# Crystal Shell generated config (Hyprland settings from UI)
# Seeded with the detected system keyboard layout on first install.
if [ ! -f "$CONFIG_DIR/crystal-settings.lua" ]; then
    cat > "$CONFIG_DIR/crystal-settings.lua" <<LUA
-- CRYSTAL SHELL SETTINGS
-- Auto-generated by the Crystal Shell Settings UI. Do not edit manually.
hl.config({
    input = {
        sensitivity        = 0.00,
        accel_profile      = "adaptive",
        natural_scroll     = false,
        numlock_by_default = false,
        kb_layout          = "$SYS_KB_LAYOUT",
        kb_variant         = "",
        repeat_delay       = 600,
        repeat_rate        = 25,
        touchpad = {
            natural_scroll = false,
            tap_to_click   = true,
        },
    },
})
LUA
    chown "$REAL_USER" "$CONFIG_DIR/crystal-settings.lua"
    echo "  [Init] $CONFIG_DIR/crystal-settings.lua (kb_layout=$SYS_KB_LAYOUT)"
fi

# Monitor config — generated by Display settings page
if [ ! -f "$CONFIG_DIR/crystal-monitor.lua" ]; then
    touch "$CONFIG_DIR/crystal-monitor.lua"
    chown "$REAL_USER" "$CONFIG_DIR/crystal-monitor.lua"
    echo "  [Init] $CONFIG_DIR/crystal-monitor.lua"
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

# hyprland-user.lua — symlink into ~/.config/hypr/ so Autostart settings page
# can read/write it from a predictable location regardless of install mode
USERCONF_LINK="${REAL_HOME}/.config/hypr/hyprland-user.lua"
USERCONF_TARGET="$CONFIG_DIR/hyprland-user.lua"
ln -sf "$USERCONF_TARGET" "$USERCONF_LINK"
echo "  [Symlink] $USERCONF_LINK -> $USERCONF_TARGET"

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
    sudo sed 's/kb_layout = "us"/kb_layout = "'"$SYS_KB_LAYOUT"'"/' \
        "$REPO_DIR/config/greetd/hyprland-greeter.lua" \
        | sudo tee /etc/greetd/hyprland-greeter.lua > /dev/null
    sudo chmod 644 /etc/greetd/config.toml /etc/greetd/hyprland-greeter.lua

    # Symlink greeter Hyprland config to the greeter user's default location
    # (HYPRLAND_CONFIG in config.toml already points here; symlink is a fallback)
    GREETER_HOME=$(getent passwd greeter | cut -d: -f6)
    if [ -n "$GREETER_HOME" ]; then
        sudo mkdir -p "$GREETER_HOME/.config/hypr"
        sudo ln -sf /etc/greetd/hyprland-greeter.lua "$GREETER_HOME/.config/hypr/hyprland.lua"
        sudo chown -R greeter:greeter "$GREETER_HOME/.config"
        echo "  [OK] Greeter Hyprland config symlinked to $GREETER_HOME/.config/hypr/hyprland.lua"
    fi

    sudo systemctl enable greetd
    echo "  [OK] greetd enabled."
else
    echo "  Display manager '$ACTIVE_DM' already enabled — skipping greetd setup."
fi

# ── Crystal Shell unit ────────────────────────────────────────────────────────
# WantedBy=graphical-session.target → starts with the session; Restart=on-failure
# respawns it on crash. Not --now: it starts inside the graphical session.
echo "  Enabling crystal-shell.service (auto-respawn)..."
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable crystal-shell.service 2>/dev/null || true

# ── Audio services ────────────────────────────────────────────────────────────
echo "  Enabling audio services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse 2>/dev/null || true

# ── Power profiles ────────────────────────────────────────────────────────────
# Game mode toggles performance/balanced via powerprofilesctl (hyprland.lua).
echo "  Enabling power-profiles-daemon..."
sudo systemctl enable --now power-profiles-daemon 2>/dev/null || true

echo ""
echo "  ✓ Installation complete ($MODE mode)"
if [ "$MODE" = "dev" ]; then
    echo "  Dev: crystal-shell-ui will run from source at $REPO_DIR"
    echo "  To exit dev mode: rm $CONFIG_DIR/.dev && install.sh"
fi
echo "  Select 'Crystal Shell' at the login screen."
echo ""
