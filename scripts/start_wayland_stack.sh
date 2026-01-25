#!/bin/bash

# Asegurar variables de entorno para Wayland
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
# Esto ayuda a que GTK4 prefiera Wayland
export MOZ_ENABLE_WAYLAND=1 

# FIX: Link Order Hell in Python + GTK4 Layer Shell
# These vars interfere with C++ apps like Waybar, so we apply them locally to Python
PY_ENV="GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH \
LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH \
LD_PRELOAD=/usr/local/lib/x86_64-linux-gnu/libgtk4-layer-shell.so"

echo "🚀 Iniciando DistroIA UI en modo Wayland..."

# Directorio raiz
cd $HOME/Dev/MiDistroIA

# Iniciar componentes
# Nota: En Wayland/Hyprland no necesitamos 'sleep' para wmctrl,
# los componentes deberían posicionarse con LayerShell (si está implementado)
# o flotar si no.

env $PY_ENV python3 ui/dock/main_dock.py &
PID_DOCK=$!

env -u LD_PRELOAD waybar &
PID_TOPBAR=$!

echo "✅ UI Iniciada (PIDs: $PID_DOCK, $PID_TOPBAR)"
wait
