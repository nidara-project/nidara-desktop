#!/bin/bash
# start_ui.sh - Production startup (called by Hyprland exec-once)
# NO dev mode, NO killall, NO cache wipe, NO hyprctl reload

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland

INSTALL_DIR="$HOME/.config/crystal-shell"
AGS_DIR="$INSTALL_DIR/ui/ags-v3"

echo "[$(date)] Crystal Shell starting..."

# Kill any existing instance cleanly
killall -9 ags gjs 2>/dev/null || true
sleep 0.2

# Resolve AGS binary
AGS_BIN="ags"
if [ -f "$HOME/.local/bin/ags" ]; then
    AGS_BIN="$HOME/.local/bin/ags"
fi

# Set library paths and launch
export GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:${GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:${LD_LIBRARY_PATH}"

cd "$AGS_DIR"
nohup "$AGS_BIN" run app.ts > /tmp/ags.log 2>&1 &
disown

echo "Crystal Shell started. Log: /tmp/ags.log"
