#!/bin/bash

echo "🧪 Iniciando Sesión de Pruebas DistroIA (Wayland Nested)..."

# Verificar si Hyprland existe
if ! command -v Hyprland &> /dev/null; then
    echo "❌ Hyprland no está instalado. Ejecuta 'bash scripts/setup_wayland_dev.sh' primero."
    exit 1
fi

PROJECT_ROOT="$HOME/Dev/MiDistroIA"
CONFIG_FILE="$PROJECT_ROOT/config/hypr/hyprland.conf"

# Ejecutar Hyprland usando nuestra config
# Esto abrirá una ventana dentro de tu sesión actual
Hyprland -c "$CONFIG_FILE"
