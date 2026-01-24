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

# Iniciar la top bar en segundo plano
echo "🚀 Iniciando TopBar desde: $PROJECT_ROOT"
python3 "$PROJECT_ROOT/ui/topbar/main_topbar.py" > /dev/null 2>&1 &

echo "✨ MiDistroIA TopBar iniciada"
