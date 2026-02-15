#!/bin/bash
# reload_ui.sh - Simple & Reliable restarter (V123: EndeavourOS Support)

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && cd .. && pwd )"
AGS_DIR="$PROJECT_ROOT/ui/ags-v3"
LOG_FILE="/tmp/ags_reload.log"

echo "[$(date)] 🔄 Restaurando estabilidad TOTAL (Poppi Edition)..."

# 0. Compilar CSS
if [ -f "$AGS_DIR/style.scss" ]; then
    echo "🎨 Compilando estilos..."
    npx sass "$AGS_DIR/style.scss" "$AGS_DIR/style.css"
fi

# 1. Limpiar procesos
killall -9 ags gjs swaybg mako dunst swww-daemon 2>/dev/null || true
sleep 0.2

# 2. Recargar Hyprland
hyprctl reload

# 3. Lanzar AGS
cd "$AGS_DIR"
# Arch Linux standard paths
GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:$AGS_DIR/astal-local/lib/linux/girepository-1.0:$GI_TYPELIB_PATH" \
LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$AGS_DIR/astal-local/lib/linux:$LD_LIBRARY_PATH" \
AGS_BIN="ags"
if [ -f "$HOME/.local/bin/ags" ]; then
    AGS_BIN="$HOME/.local/bin/ags"
fi

nohup "$AGS_BIN" run --gtk 4 . > /tmp/ags.log 2>&1 &
disown

# 4. Fondo de pantalla (swww con transiciones animadas) 💎
if ! pgrep -x "swww-daemon" > /dev/null; then
    swww-daemon &
    sleep 0.5
fi

# Cargar configuración si existe
# Cargar configuración si existe
CONFIG_WALLPAPER="$PROJECT_ROOT/config/wallpaper.sh"
if [ -f "$CONFIG_WALLPAPER" ]; then
    source "$CONFIG_WALLPAPER"
fi

# Fallback si las variables no están definidas
WALLPAPER_PATH="${WALLPAPER_PATH:-$PROJECT_ROOT/config/wallpaper.png}"
TRANSITION_TYPE="${TRANSITION_TYPE:-grow}"

if [ -f "$WALLPAPER_PATH" ]; then
    swww img "$WALLPAPER_PATH" \
        --transition-type "$TRANSITION_TYPE" \
        --transition-step "${TRANSITION_STEP:-90}" \
        --transition-fps "${TRANSITION_FPS:-60}" \
        --transition-pos "${TRANSITION_POS:-0.5,0.5}"
fi

echo "✅ Sistema estable y con todos los iconos."
