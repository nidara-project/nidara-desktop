#!/bin/bash
# Crystal Shell - ISO Provisioning Script 💎
# Designed for EndeavourOS / Arch Linux 🚀

set -e

echo "🚀 Starting Crystal Shell Provisioning (Arch Linux Mode)..."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
INSTALL_DIR="$HOME/.config/crystal-shell"

if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
    echo "=========================================="
    echo "💎 Crystal Shell Installation Mode"
    echo "=========================================="
    echo "Elige el modo de instalación para $INSTALL_DIR:"
    echo "1) Instalación Normal (Copia de archivos - Recomendado para usuarios)"
    echo "2) Instalación de Desarrollo (Symlink - Recomendado para programar)"
    
    # V124: Robust Read with timeout & forced default
    INSTALL_MODE="1"
    read -p ">> Selecciona [1/2] (por defecto 1): " -t 30 USER_INPUT
    INSTALL_MODE=${USER_INPUT:-1}

    if [ "$INSTALL_MODE" = "2" ]; then
        echo "🔗 Creando enlace simbólico de desarrollo..."
        # Surgical swap: ensures no directory residues
        if [ -d "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
            echo "⚠️  Detectada carpeta física instalada. Reemplazando por Symlink..."
            rm -rf "$INSTALL_DIR"
        fi
        ln -sfn "$REPO_DIR" "$INSTALL_DIR"
    else
        echo "📂 Copiando los archivos base..."
        mkdir -p "$INSTALL_DIR"
        cp -rT "$REPO_DIR" "$INSTALL_DIR"
    fi
fi

# 1. System Dependencies
echo "📦 Installing system dependencies via pacman..."
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
    xdg-desktop-portal-gtk \
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
echo "🛠️ Compiling appmenu-glib-translator..."
mkdir -p /tmp/astal-deps
cd /tmp/astal-deps
if [ ! -d "vala-panel-appmenu" ]; then
    git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git
fi
cd vala-panel-appmenu/subprojects/appmenu-glib-translator
# Clean old build dir if it exists
rm -rf build
meson setup build --prefix=/usr
sudo meson install -C build

# 3. Build & Install Astal Libraries (The "Secret Sauce")
echo "🛠️ Compiling Astal Service Libraries..."
mkdir -p /tmp/astal-build
cd /tmp/astal-build
if [ ! -d "astal" ]; then
    git clone https://github.com/aylur/astal.git
fi
cd astal

# List of components to install in order
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
    echo "🔨 Building $comp..."
    pushd "$comp"
    rm -rf build
    meson setup build --prefix=/usr
    sudo meson install -C build
    popd
done

# 4. Global Path Configuration & Linker Cache
echo "⚙️ Configuring Global GI_TYPELIB_PATH & Library Cache..."
# On Arch, typelibs are usually in /usr/lib/girepository-1.0
TYPELIB_PATH="/usr/lib/girepository-1.0"
LIB_PATH="/usr/lib"

# Refresh shared library cache
echo "🔄 Refreshing system library cache (ldconfig)..."
sudo ldconfig

# Add to /etc/environment for global access
if ! grep -q "GI_TYPELIB_PATH" /etc/environment; then
    echo "GI_TYPELIB_PATH=\"$TYPELIB_PATH\"" | sudo tee -a /etc/environment
else
    # Update existing if needed
    sudo sed -i "s|GI_TYPELIB_PATH=.*|GI_TYPELIB_PATH=\"$TYPELIB_PATH\"|g" /etc/environment
fi

# 5. Build & Install AGS CLI (The Launcher)
echo "🛠️ Compiling AGS v3 CLI (Launcher)..."
mkdir -p /tmp/ags-build
cd /tmp/ags-build
if [ ! -d "ags" ]; then
    git clone https://github.com/aylur/ags.git
fi
cd ags
rm -rf build
# We need gnim for the build
npm install
meson setup build --prefix=/usr
sudo meson install -C build

# 6. UI Setup
echo "🖥️ Setting up AGS UI..."
cd "$INSTALL_DIR/ui/ags-v3" || echo "⚠️ UI Directory not found, skipping npm install."
npm install
echo "🎨 Compiling SCSS..."
npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css

# 7. Enable Audio Services
echo "🔊 Enabling Audio Services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse

# 8. Configure System Session (SDDM & Hyprland)
echo "🎬 Configuring Session Start..."

# Enable SDDM (Display Manager)
echo "Login Manager (SDDM)..."
sudo systemctl enable sddm

# Link Hyprland Config
echo "🔗 Linking Hyprland Configuration..."
mkdir -p "$HOME/.config/hypr"
# Backup existing config if it's not a symlink
if [ -f "$HOME/.config/hypr/hyprland.conf" ] && [ ! -L "$HOME/.config/hypr/hyprland.conf" ]; then
    mv "$HOME/.config/hypr/hyprland.conf" "$HOME/.config/hypr/hyprland.conf.bak"
fi
ln -sf "$INSTALL_DIR/config/hypr/hyprland.conf" "$HOME/.config/hypr/hyprland.conf"
 
 # 9. Configure XDG Portals (Modern Apps Theme Support)
 echo "🎨 Configuring XDG Desktop Portals..."
 mkdir -p "$HOME/.config/xdg-desktop-portal"
 cat <<EOF > "$HOME/.config/xdg-desktop-portal/portals.conf"
 [preferred]
 default=gtk
 org.freedesktop.impl.portal.ScreenCast=hyprland
 org.freedesktop.impl.portal.Screenshot=hyprland
 EOF

 # 10. Desktop Session Entry
 echo "📝 Creating Crystal Shell Desktop Entry for Display Managers..."
 sudo mkdir -p /usr/share/wayland-sessions
 cat <<EOF | sudo tee /usr/share/wayland-sessions/crystal-shell.desktop > /dev/null
[Desktop Entry]
Name=Crystal Shell
Comment=A fluid, glassmorphic desktop environment based on Hyprland & AGS
Exec=start-hyprland
Type=Application
DesktopNames=Hyprland
EOF

# 11. Install Application Entries
echo "📝 Installing application entries..."
mkdir -p "$HOME/.local/share/applications"
if [ "$INSTALL_MODE" = "2" ]; then
    # Dev mode: symlink so changes in repo are reflected immediately
    for f in "$INSTALL_DIR/config/applications/"*.desktop; do
        ln -sf "$f" "$HOME/.local/share/applications/$(basename "$f")"
    done
else
    cp "$INSTALL_DIR/config/applications/"*.desktop "$HOME/.local/share/applications/"
fi
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true

echo "✅ Provisioning Complete!"
echo "👉 Restart (or run 'sudo systemctl start sddm') and select 'Crystal Shell' from the login screen."
