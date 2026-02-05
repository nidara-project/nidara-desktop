#!/bin/bash
# MiDistroIA - ISO Provisioning Script 💎
# Designed for Cubic (Ubuntu) or direct post-install automation.

set -e

echo "🚀 Starting MiDistroIA Provisioning..."

# 1. System Dependencies & Repairs
echo "📦 Preparing system and fixing potential broken packages..."
sudo apt update
sudo apt install -f -y

# Install Node.js & NPM via NodeSource (More reliable on Ubuntu)
echo "🌐 Installing Node.js 20.x (LTS) via NodeSource..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

echo "📦 Installing build dependencies..."
sudo apt install -y \
    meson \
    ninja-build \
    libgirepository1.0-dev \
    valac \
    libgtk-4-dev \
    libadwaita-1-dev \
    libpulse-dev \
    libnm-dev \
    libbluetooth-dev \
    libgbm-dev \
    libpam0g-dev \
    git \
    nodejs

# 2. Build & Install Dependencies (Vala Panel Appmenu)
# Required for AstalTray
echo "🛠️ Compiling appmenu-glib-translator..."
mkdir -p /tmp/astal-deps
cd /tmp/astal-deps
git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git . || (cd . && git pull)
cd subprojects/appmenu-glib-translator
# Clean old build dir if it exists
rm -rf build
meson setup build --prefix=/usr/local
sudo meson install -C build

# 3. Build & Install Astal Libraries (The "Secret Sauce")
echo "🛠️ Compiling Astal Service Libraries..."
mkdir -p /tmp/astal-build
cd /tmp/astal-build
git clone https://github.com/aylur/astal.git . || (cd . && git pull)

# List of components to install in order
# NOTE: lib/astal is split into io and gtk4
COMPONENTS=(
    "lib/astal/io" 
    "lib/astal/gtk4" 
    "lib/apps" 
    "lib/hyprland" 
    "lib/mpris" 
    "lib/network" 
    "lib/battery" 
    "lib/notifd" 
    "lib/bluetooth" 
    "lib/tray"
)

for comp in "${COMPONENTS[@]}"; do
    echo "🔨 Building $comp..."
    cd "/tmp/astal-build/$comp"
    # Clean old build dir if it exists
    rm -rf build
    meson setup build --prefix=/usr/local
    sudo meson install -C build
done

# 3. Global Path Configuration
echo "⚙️ Configuring Global GI_TYPELIB_PATH..."
# Find where typelibs are (Ubuntu usually puts them in x86_64-linux-gnu subdirectory)
TYPELIB_PATH="/usr/local/lib/x86_64-linux-gnu/girepository-1.0"
if [ ! -d "$TYPELIB_PATH" ]; then
    TYPELIB_PATH="/usr/local/lib/girepository-1.0"
fi

# Add to /etc/environment for global access
if ! grep -q "GI_TYPELIB_PATH" /etc/environment; then
    echo "GI_TYPELIB_PATH=\"$TYPELIB_PATH:$GI_TYPELIB_PATH\"" | sudo tee -a /etc/environment
else
    sudo sed -i "s|GI_TYPELIB_PATH=\"|GI_TYPELIB_PATH=\"$TYPELIB_PATH:|g" /etc/environment
fi

# 4. Icon Theme & Assets
echo "🎨 Installing Design Assets..."
mkdir -p ~/.local/share/icons
# (Assumption: Icons are packaged or cloned here)
# cp -r ./assets/icons/* ~/.local/share/icons/

# 5. UI Setup
echo "🖥️ Setting up AGS UI..."
cd ~/Dev/MiDistroIA/ui/ags-v3
npm install

echo "✅ Provisioning Complete! Restart your session."
