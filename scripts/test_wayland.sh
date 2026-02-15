#!/bin/bash

echo "🧪 Iniciando Sesión de Pruebas DistroIA (Wayland Nested)..."

# Verificar si Hyprland existe
if ! command -v Hyprland &> /dev/null; then
    echo "❌ Hyprland no está instalado."
    exit 1
fi

PROJECT_ROOT="$HOME/Dev/Distroia"
CONFIG_FILE="$PROJECT_ROOT/config/hypr/hyprland.conf"

# --- AQUAMARINE FIXES (New Hyprland Backend) ---

# 1. Disable DRM/KMS probing (prevents "Device or resource busy" error)
export AQ_DRM_DEVICES=""

# 2. Force software cursors if needed (crash safety)
export WLR_NO_HARDWARE_CURSORS=1
export AQ_NO_MODIFIERS=1

# 3. Ensure we see the X11 host
export GDK_BACKEND=x11
unset WAYLAND_DISPLAY

echo "Launch params:"
echo "Config: $CONFIG_FILE"
echo "Backend: Legacy X11 Nesting (Aquamarine)"

# Run Hyprland
# We capture log to /tmp just in case
Hyprland -c "$CONFIG_FILE" > /tmp/hyprland_nested.log 2>&1
