#!/bin/bash
# start_wayland_stack.sh - Isolated for DistroIA

# 1. Environment and Directories
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
export MOZ_ENABLE_WAYLAND=1 
ROOT_DIR="$HOME/Dev/MiDistroIA"
AGS_DIR="$ROOT_DIR/ui/ags-v3"
ISOLATED_CONF="$AGS_DIR/isolated_config"

# --- PREMIUM NATIVE STACK ---
export GI_TYPELIB_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH"
export LD_LIBRARY_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
export XDG_DATA_DIRS="$AGS_DIR/astal-local/share:$XDG_DATA_DIRS"

cd "$AGS_DIR"

# 2. Start AGS
GDK_BACKEND=wayland \
PATH="$PATH:$(pwd)/node_modules/.bin" \
ags run --gtk 4 . > /tmp/ags.log 2>&1 &

exit 0
