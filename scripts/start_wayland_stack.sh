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
echo "🚀 Iniciando Dock (AGS v3) en aislamiento total..."
# Use XDG_CONFIG_HOME to hide system/user gtk.css
# Use GTK_THEME=Empty to avoid fallback to system Adwaita
XDG_CONFIG_HOME="$ISOLATED_CONF" \
GTK_THEME=Empty \
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
