#!/bin/bash
# reload_ui.sh - Robust UI stack restarter for DistroIA

# --- PREMIUM NATIVE STACK ---
AGS_DIR="/home/angel/Dev/MiDistroIA/ui/ags-v3"
export GI_TYPELIB_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH"
export LD_LIBRARY_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
export XDG_DATA_DIRS="$AGS_DIR/astal-local/share:$XDG_DATA_DIRS"

LOG_FILE="/tmp/ags_reload.log"
echo "[$(date)] 🔄 Reiniciando stack de UI DistroIA..." | tee -a "$LOG_FILE"
notify-send "DistroIA" "Reiniciando interfaz..." -i preferences-desktop-theme -t 1000

# 1. Recargar Hyprland config
hyprctl reload

# 2. Matar procesos existentes de forma instantánea
killall -9 ags gjs 2>/dev/null || true
pkill -9 waybar 2>/dev/null || true
pkill -9 swaync 2>/dev/null || true
pkill -9 swaybg 2>/dev/null || true
sleep 0.2

# 3. Reiniciar Wallpaper
(swaybg -i /home/angel/Pictures/wallpaper.jpg -m fill &)

# 4. Iniciar Stack AGS (Barra y Dock)
bash /home/angel/Dev/MiDistroIA/scripts/start_wayland_stack.sh &

echo "✅ UI reiniciada." | tee -a "$LOG_FILE"
