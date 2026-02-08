#!/bin/bash
# reload_ui.sh - Simple & Reliable restarter (V123: EndeavourOS Support)

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && cd .. && pwd )"
AGS_DIR="$PROJECT_ROOT/ui/ags-v3"
LOG_FILE="/tmp/ags_reload.log"

echo "[$(date)] 🔄 Restaurando estabilidad TOTAL (Poppi Edition)..."

# 1. Limpiar procesos
killall -9 ags gjs swaybg mako dunst swww-daemon 2>/dev/null || true
sleep 0.2

# 2. Recargar Hyprland
hyprctl reload

# 3. Lanzar AGS
cd "$AGS_DIR"
# Arch Linux standard paths
GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:$AGS_DIR/astal-local/lib/linux/girepository-1.0:$GI_TYPELIB_PATH" \
LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$AGS_DIR/astal-local/lib/linux:$LD_LIBRARY_PATH" \
nohup ags run --gtk 4 . > /tmp/ags.log 2>&1 &
disown

# 4. Fondo de pantalla (swww para transiciones premium)
swww-daemon &
sleep 0.5
swww img /home/angel/Dev/DistroIA/config/wallpaper.png --transition-type grow --transition-pos 0.5,0.5 --transition-step 90
# Usar una ruta relativa o configurable si es posible
WALLPAPER="$HOME/Pictures/wallpaper.jpg"
if [ ! -f "$WALLPAPER" ]; then
    # Fallback to a default asset if exists
    WALLPAPER="$PROJECT_ROOT/assets/wallpapers/current.jpg"
fi

if [ -f "$WALLPAPER" ]; then
    nohup swaybg -i "$WALLPAPER" -m fill >/dev/null 2>&1 &
    disown
fi

echo "✅ Sistema estable y con todos los iconos."
