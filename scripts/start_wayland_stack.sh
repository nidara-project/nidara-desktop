#!/bin/bash
# start_wayland_stack.sh - Isolated for DistroIA

# 1. Environment and Directories
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
export MOZ_ENABLE_WAYLAND=1 
ROOT_DIR="$HOME/Dev/MiDistroIA"
AGS_DIR="$ROOT_DIR/ui/ags-v3"
ISOLATED_CONF="$AGS_DIR/isolated_config"

cd "$AGS_DIR"

# 2. Start Dock in Absolute Isolation
echo "🚀 Iniciando Dock (AGS v3)..."
# Removed GTK_THEME=Empty to allow system icons (Yaru)
# Removed XDG_CONFIG_HOME isolation to allow theme lookup
GDK_BACKEND=wayland \
PATH="$PATH:$(pwd)/node_modules/.bin" \
ags run --gtk 4 . > /tmp/ags.log 2>&1 &
PID_DOCK=$!

# 3. Start Waybar
echo "🚀 Iniciando Waybar..."
LD_PRELOAD="" waybar &
PID_TOPBAR=$!

echo "✅ UI Iniciada (PIDs: $PID_DOCK, $PID_TOPBAR)"
wait
