#!/bin/bash
# Master launcher for DistroIA

# Calcular directorio base del proyecto
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🚀 Master Launcher iniciando desde: $PROJECT_ROOT"

if [ -f "$PROJECT_ROOT/scripts/reload_ui.sh" ]; then
    bash "$PROJECT_ROOT/scripts/reload_ui.sh"
else
    echo "⚠️ Error: reload_ui.sh no encontrado."
fi
