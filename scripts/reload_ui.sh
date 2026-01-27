#!/bin/bash
# reload_ui.sh - Robust UI stack restarter for DistroIA

echo "🔄 Reiniciando stack de UI DistroIA..."

# 1. Recargar Hyprland config (solo la lógica del compositor)
hyprctl reload
sleep 0.5

# 2. Matar procesos existentes
pkill waybar
pkill -f main_dock.py
pkill swaybg
sleep 0.5

# 3. Reiniciar Wallpapaer (Swaybg)
(swaybg -i /home/angel/Pictures/wallpaper.jpg -m fill &)

# 4. Iniciar Stack Wayland (Barra y Dock)
# Usar el script original start_wayland_stack.sh pero de forma robusta
bash /home/angel/Dev/MiDistroIA/scripts/start_wayland_stack.sh &

echo "✅ UI reiniciada con éxito."
