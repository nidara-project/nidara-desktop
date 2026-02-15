#!/bin/bash
# MiDistroIA - ISO Provisioning Script 💎
# Designed for EndeavourOS / Arch Linux 🚀

set -e

echo "🚀 Starting MiDistroIA Provisioning (Arch Linux Mode)..."

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
    intltool \
    scdoc \
    brightnessctl \
    pamixer \
    hyprpicker \
    jq \
    slurp \
    grim \
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
    kitty \
    thunar \
    ttf-jetbrains-mono-nerd \
    noto-fonts-emoji \
    xfce4-settings

# 1.1 SWWW (Wallpaper Daemon) - Rust Build
if ! command -v swww &> /dev/null; then
    echo "🖼️ Installing SWWW (Wallpaper Daemon)..."
    # Ensure cargo bin is in path for this session
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo install --locked swww
    # Symlink to /usr/bin for global access if needed, or rely on cargo path
    sudo ln -sf "$HOME/.cargo/bin/swww" /usr/bin/swww
    sudo ln -sf "$HOME/.cargo/bin/swww-daemon" /usr/bin/swww-daemon
fi

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
cd "$HOME/Dev/Distroia/ui/ags-v3" || echo "⚠️ UI Directory not found, skipping npm install."
npm install

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
ln -sf "$HOME/Dev/Distroia/config/hypr/hyprland.conf" "$HOME/.config/hypr/hyprland.conf"

echo "✅ Provisioning Complete!"
echo "👉 Restart (or run 'sudo systemctl start sddm') to enter SDDM."

