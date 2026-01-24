#!/bin/bash

# Asegurar variables de entorno para Wayland
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
# Esto ayuda a que GTK4 prefiera Wayland
export MOZ_ENABLE_WAYLAND=1 

echo "🚀 Iniciando DistroIA UI en modo Wayland..."

# Directorio raiz
cd $HOME/Dev/MiDistroIA

# Iniciar componentes
# Nota: En Wayland/Hyprland no necesitamos 'sleep' para wmctrl,
# los componentes deberían posicionarse con LayerShell (si está implementado)
# o flotar si no.

python3 ui/dock/main_dock.py &
PID_DOCK=$!

python3 ui/topbar/main_topbar.py &
PID_TOPBAR=$!

echo "✅ UI Iniciada (PIDs: $PID_DOCK, $PID_TOPBAR)"
wait
