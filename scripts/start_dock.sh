#!/bin/bash
# Script para lanzar el Dock de MiDistroIA
# Portable: Funciona en Dev (~/Dev/...) y en Producción (/opt/...)

# Calcular directorio base del proyecto
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Matar instancias previas
pkill -f "main_dock.py"
pkill -f "monitor.py"

# Esperar un momento
sleep 1

# FIX: Link Order Hell in Python + GTK4 Layer Shell
export GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0:$GI_TYPELIB_PATH
export LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
export LD_PRELOAD=/usr/local/lib/x86_64-linux-gnu/libgtk4-layer-shell.so

# Force Wayland backend if in Wayland
if [ "$XDG_SESSION_TYPE" == "wayland" ]; then
    export GDK_BACKEND=wayland
fi

# Export locales to ensure Python doesn't complain
export LC_ALL=es_ES.UTF-8
export LANG=es_ES.UTF-8

# Lanzar el dock usando ruta relativa
echo "🚀 Iniciando Dock desde: $PROJECT_ROOT"
python3 "$PROJECT_ROOT/ui/dock/main_dock.py" &

echo "✨ MiDistroIA Dock iniciado"
