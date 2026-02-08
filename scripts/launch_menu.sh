#!/bin/bash

# Define variables
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && cd .. && pwd )"
MENU_SCRIPT="$PROJECT_ROOT/ui/menu/app_launcher.py"
PROCESS_NAME="ui/menu/app_launcher.py"

# Fix LayerShell Linking (INLINE ONLY)
# export GI_TYPELIB_PATH=/usr/lib/girepository-1.0:$GI_TYPELIB_PATH
# export LD_LIBRARY_PATH=/usr/lib:$LD_LIBRARY_PATH
# export LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so

# Ensure Wayland Detection
# Check if running
if pgrep -f "$PROCESS_NAME" > /dev/null; then
    echo "Menu is open. Closing..."
    pkill -f "$PROCESS_NAME"
else
    echo "Launching Menu..."
    # Ensure environment is correct
    export PYTHONPATH="$PROJECT_ROOT"
    
    # Use env to set Wayland variables ONLY for the menu process
    GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:$PROJECT_ROOT/ui/ags-v3/astal-local/lib/linux/girepository-1.0:$GI_TYPELIB_PATH" \
    LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$PROJECT_ROOT/ui/ags-v3/astal-local/lib/linux:$LD_LIBRARY_PATH" \
    LD_PRELOAD="/usr/lib/libgtk4-layer-shell.so" \
    env GDK_BACKEND=wayland XDG_SESSION_TYPE=wayland python3 "$MENU_SCRIPT" &
fi
