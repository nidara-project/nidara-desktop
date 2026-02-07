#!/bin/bash
# reload_ui.sh - Simple & Reliable restarter (V122: Flatpak/Snap Support)

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
AGS_DIR="/home/angel/Dev/MiDistroIA/ui/ags-v3"
LOG_FILE="/tmp/ags_reload.log"

echo "[$(date)] 🔄 Restaurando estabilidad TOTAL..."

# 1. Limpiar procesos
killall -9 ags gjs swaybg 2>/dev/null || true
sleep 0.2

# 2. Recargar Hyprland
hyprctl reload

# 3. Lanzar AGS
cd "$AGS_DIR"
GI_TYPELIB_PATH="/usr/local/lib/x86_64-linux-gnu/girepository-1.0:/usr/local/lib/girepository-1.0:$AGS_DIR/astal-local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH" \
LD_LIBRARY_PATH="/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:$AGS_DIR/astal-local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH" \
nohup ags run --gtk 4 . > /tmp/ags.log 2>&1 &
disown

# 5. Reiniciar Wallpaper
nohup swaybg -i /home/angel/Pictures/wallpaper.jpg -m fill >/dev/null 2>&1 &
disown

echo "✅ Sistema estable y con todos los iconos."
