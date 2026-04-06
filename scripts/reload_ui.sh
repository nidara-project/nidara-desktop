#!/bin/bash
# reload_ui.sh - Development reload script for Crystal Shell

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
export CRYSTAL_DEV_MODE=1
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && cd .. && pwd )"
AGS_DIR="$PROJECT_ROOT/ui/ags-v3"
LOG_FILE="/tmp/ags_reload.log"

echo "[$(date)] Reloading Crystal Shell..."

# Compile SCSS
if [ -f "$AGS_DIR/style.scss" ]; then
    echo "Compiling styles..."
    sass --no-charset "$AGS_DIR/style.scss" "$AGS_DIR/style.css"
    sed -i '/@charset/d' "$AGS_DIR/style.css"
fi

# Kill existing processes
killall -9 ags gjs 2>/dev/null || true
# Clear compiler cache (stale JS bundles can survive across reloads)
rm -rf ~/.cache/ags ~/.cache/astal /tmp/ags* /tmp/astal* 2>/dev/null || true
# Leave awww-daemon running to preserve wallpaper during reload
sleep 0.2

# Reload Hyprland
hyprctl reload

# Launch AGS with Astal library paths
cd "$AGS_DIR"

export GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:${GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:${LD_LIBRARY_PATH}"

AGS_BIN="ags"
if [ -f "$HOME/.local/bin/ags" ]; then
    AGS_BIN="$HOME/.local/bin/ags"
fi

nohup "$AGS_BIN" run app.ts > /tmp/ags.log 2>&1 &
disown

echo "Crystal Shell reloaded."
