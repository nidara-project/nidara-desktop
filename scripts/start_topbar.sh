#!/bin/bash
# Script para lanzar el TopBar de MiDistroIA
# Portable: Funciona en Dev (~/Dev/...) y en Producción (/opt/...)

# Calcular directorio base del proyecto
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Matar procesos anteriores
pkill -f main_topbar.py

# Esperar un poco
sleep 0.5

# FIX: Link Order Hell in Python + GTK4 Layer Shell (INLINE ONLY)
# export GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH
# export LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
# export LD_PRELOAD=/usr/local/lib/x86_64-linux-gnu/libgtk4-layer-shell.so

# Force Wayland backend if in Wayland
if [ "$XDG_SESSION_TYPE" == "wayland" ]; then
    export GDK_BACKEND=wayland
fi

# Iniciar la top bar en segundo plano
echo "🚀 Iniciando TopBar desde: $PROJECT_ROOT"
GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:$PROJECT_ROOT/ui/ags-v3/astal-local/lib/linux/girepository-1.0:$GI_TYPELIB_PATH" \
LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$PROJECT_ROOT/ui/ags-v3/astal-local/lib/linux:$LD_LIBRARY_PATH" \
LD_PRELOAD="/usr/lib/libgtk4-layer-shell.so" \
python3 "$PROJECT_ROOT/ui/topbar/main_topbar.py" > /dev/null 2>&1 &

echo "✨ MiDistroIA TopBar iniciada"
