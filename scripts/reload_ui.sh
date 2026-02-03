#!/bin/bash
# reload_ui.sh - Robust UI stack restarter for DistroIA 🛡️💎

AGS_DIR="/home/angel/Dev/MiDistroIA/ui/ags-v3"
export GI_TYPELIB_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH"
export LD_LIBRARY_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
export XDG_DATA_DIRS="$AGS_DIR/astal-local/share:$XDG_DATA_DIRS"

LOG_FILE="/tmp/ags_reload.log"
echo "[$(date)] 🔄 Iniciando recarga robusta de DistroIA..." | tee -a "$LOG_FILE"

# 1. Matar procesos existentes agresivamente
killall -9 ags gjs 2>/dev/null || true
pkill -9 swaybg 2>/dev/null || true
sleep 0.1

# 2. Recargar Hyprland y esperar a que el socket responda
hyprctl reload
for i in {1..20}; do
    if hyprctl version &>/dev/null; then
        echo "✅ Hyprland Ready!" | tee -a "$LOG_FILE"
        break
    fi
    sleep 0.1
done

# 3. Reiniciar Wallpaper
swaybg -i /home/angel/Pictures/wallpaper.jpg -m fill &

# 4. Breve espera para estabilización de DRM antes de AGS
sleep 0.5

# 5. Iniciar Stack AGS
bash /home/angel/Dev/MiDistroIA/scripts/start_wayland_stack.sh &

echo "✨ Recarga completada exitosamente." | tee -a "$LOG_FILE"
