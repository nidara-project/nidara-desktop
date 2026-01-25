#!/bin/bash
# Master launcher for DistroIA

# Calcular directorio base del proyecto
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🚀 Master Launcher iniciando desde: $PROJECT_ROOT"

if [ -f "$PROJECT_ROOT/scripts/start_dock.sh" ]; then
    bash "$PROJECT_ROOT/scripts/start_dock.sh" &
fi

if [ -f "$PROJECT_ROOT/scripts/start_topbar.sh" ]; then
    bash "$PROJECT_ROOT/scripts/start_topbar.sh" &
fi
