#!/bin/bash
# reload_ui.sh - Robust UI stack restarter for DistroIA

# --- PREMIUM NATIVE STACK ---
AGS_DIR="/home/angel/Dev/MiDistroIA/ui/ags-v3"
export GI_TYPELIB_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH"
export LD_LIBRARY_PATH="$AGS_DIR/astal-local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
export XDG_DATA_DIRS="$AGS_DIR/astal-local/share:$XDG_DATA_DIRS"

echo "🔄 Reiniciando stack de UI DistroIA..."

# 1. Recargar Hyprland config (solo la lógica del compositor)
hyprctl reload
sleep 0.5

# 2. Matar procesos existentes
pkill waybar || true
pkill -f "gjs -m .*ags.js"
pkill -f main_dock.py # Safety for transition
pkill swaybg
sleep 0.5

# 3. Reiniciar Wallpapaer (Swaybg)
(swaybg -i /home/angel/Pictures/wallpaper.jpg -m fill &)

# 4. Iniciar Stack Wayland (Barra y Dock)
# Usar el script original start_wayland_stack.sh pero de forma robusta
bash /home/angel/Dev/MiDistroIA/scripts/start_wayland_stack.sh &

echo "✅ UI reiniciada con éxito."
