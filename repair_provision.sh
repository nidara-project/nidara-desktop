#!/bin/bash
set -e

echo "🔧 Starting Astal Local Repair..."
mkdir -p ~/.local/bin ~/.local/lib ~/.local/lib/girepository-1.0 ~/.local/share

WORK_DIR="/tmp/astal-repair"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# Clone if missing
if [ ! -d "astal" ]; then
    echo "📥 Cloning Astal..."
    git clone https://github.com/aylur/astal.git
fi
if [ ! -d "vala-panel-appmenu" ]; then
    echo "📥 Cloning vala-panel-appmenu..."
    git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git
fi

# 1. Install appmenu-glib-translator locally
echo "🔨 Building appmenu-glib-translator..."
cd "$WORK_DIR/vala-panel-appmenu/subprojects/appmenu-glib-translator"
rm -rf build
meson setup build --prefix=$HOME/.local
meson install -C build

# 2. Install Astal Components
cd "$WORK_DIR/astal"
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

export PKG_CONFIG_PATH=$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH
export GI_TYPELIB_PATH=$HOME/.local/lib/girepository-1.0:$GI_TYPELIB_PATH
export LD_LIBRARY_PATH=$HOME/.local/lib:$LD_LIBRARY_PATH

for comp in "${COMPONENTS[@]}"; do
    echo "🔨 Building $comp..."
    pushd "$comp"
    rm -rf build
    meson setup build --prefix=$HOME/.local
    meson install -C build
    popd
done

echo "✅ Repair Complete!"
echo "⚠️  Please add these to your .bashrc / .zshrc:"
echo 'export PATH=$HOME/.local/bin:$PATH'
echo 'export GI_TYPELIB_PATH=$HOME/.local/lib/girepository-1.0:$GI_TYPELIB_PATH'
echo 'export LD_LIBRARY_PATH=$HOME/.local/lib:$LD_LIBRARY_PATH'
