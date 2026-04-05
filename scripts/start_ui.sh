#!/bin/bash
# start_ui.sh - Production startup (called by Hyprland exec-once)

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland

INSTALL_DIR="$HOME/.config/crystal-shell"
AGS_DIR="$INSTALL_DIR/ui/ags-v3"
BUNDLE="$AGS_DIR/build/crystal-shell"

echo "[$(date)] Crystal Shell starting..."

# Kill any existing instance cleanly
killall -9 ags gjs 2>/dev/null || true
sleep 0.2

# Set library paths
export GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:${GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:${LD_LIBRARY_PATH}"

cd "$AGS_DIR"

if [ -x "$BUNDLE" ]; then
    # Production mode: run standalone bundle (no ags CLI needed)
    echo "[Crystal Shell] Running bundle: $BUNDLE"
    nohup "$BUNDLE" > /tmp/ags.log 2>&1 &
else
    # Dev / fallback mode: transpile from source
    echo "[Crystal Shell] Bundle not found, running from source (ags run)..."
    AGS_BIN="${HOME}/.local/bin/ags"
    [ -f "$AGS_BIN" ] || AGS_BIN="ags"
    nohup "$AGS_BIN" run app.ts > /tmp/ags.log 2>&1 &
fi

disown
echo "Crystal Shell started. Log: /tmp/ags.log"
