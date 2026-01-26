#!/bin/bash

# Define variables
MENU_SCRIPT="$HOME/Dev/MiDistroIA/ui/menu/app_launcher.py"
PROCESS_NAME="ui/menu/app_launcher.py"

# Fix LayerShell Linking
export GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH
export LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
export LD_PRELOAD=/usr/local/lib/x86_64-linux-gnu/libgtk4-layer-shell.so

# Ensure Wayland Detection
# Check if running
if pgrep -f "$PROCESS_NAME" > /dev/null; then
    echo "Menu is open. Closing..."
    pkill -f "$PROCESS_NAME"
else
    echo "Launching Menu..."
    # Ensure environment is correct
    export PYTHONPATH="$HOME/Dev/MiDistroIA"
    
    # Use env to set Wayland variables ONLY for the menu process
    # This prevents child apps (like Antigravity) from inheriting GDK_BACKEND=wayland
    # which causes crashes if they aren't fully Wayland-native.
    env GDK_BACKEND=wayland XDG_SESSION_TYPE=wayland python3 "$MENU_SCRIPT" &
fi
