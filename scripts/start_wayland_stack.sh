#!/bin/bash

# Asegurar variables de entorno para Wayland
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
# Esto ayuda a que GTK4 prefiera Wayland
export MOZ_ENABLE_WAYLAND=1 

# FIX: Link Order Hell in Python + GTK4 Layer Shell
# These vars interfere with C++ apps like Waybar, so we apply them locally to Python
# Directorio raiz
cd $HOME/Dev/MiDistroIA

# Iniciar componentes
# Nota: Usamos las rutas absolutas para las librerías de LayerShell
L_SHELL_TYPELIB="/usr/local/lib/x86_64-linux-gnu/girepository-1.0"
L_SHELL_LIB="/usr/local/lib/x86_64-linux-gnu"
L_SHELL_PRELOAD="/usr/local/lib/x86_64-linux-gnu/libgtk4-layer-shell.so"

echo "🚀 Iniciando Dock..."
GI_TYPELIB_PATH="$L_SHELL_TYPELIB:$GI_TYPELIB_PATH" \
LD_LIBRARY_PATH="$L_SHELL_LIB:$LD_LIBRARY_PATH" \
LD_PRELOAD="$L_SHELL_PRELOAD" \
PYTHONPATH="$HOME/Dev/MiDistroIA" \
python3 ui/dock/main_dock.py &
PID_DOCK=$!

echo "🚀 Iniciando Waybar..."
# Waybar no necesita LD_PRELOAD de GTK Layer Shell (usa el suyo propio)
# y a veces falla si lo tiene precargado.
LD_PRELOAD="" waybar &
PID_TOPBAR=$!

echo "✅ UI Iniciada (PIDs: $PID_DOCK, $PID_TOPBAR)"
wait
