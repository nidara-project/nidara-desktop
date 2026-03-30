#!/bin/bash
# reload_ui.sh - Simple & Reliable restarter (V123: EndeavourOS Support)

export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
export CRYSTAL_DEV_MODE=1
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && cd .. && pwd )"
AGS_DIR="$PROJECT_ROOT/ui/ags-v3"
LOG_FILE="/tmp/ags_reload.log"

echo "[$(date)] 🔄 Restaurando estabilidad TOTAL (Poppi Edition)..."

# 0. Compilar CSS con SASS
if [ -f "$AGS_DIR/style.scss" ]; then
    echo "🎨 Compilando estilos..."
    npx sass --no-charset "$AGS_DIR/style.scss" "$AGS_DIR/style.css"
    sed -i '/@charset/d' "$AGS_DIR/style.css"
fi

# 1. Limpiar procesos de forma quirúrgica
killall -9 ags gjs 2>/dev/null || true
# DESTROY COMPILER CACHE: Astal was serving 3-hour old JS bundles!
rm -rf ~/.cache/ags ~/.cache/astal /tmp/ags* /tmp/astal* 2>/dev/null || true
# Evitamos matar awww-daemon para no perder el wallpaper durante el reload
sleep 0.2

# 2. Recargar Hyprland
hyprctl reload

# 3. Lanzar AGS con el entorno de Astal-local
cd "$AGS_DIR"

export GI_TYPELIB_PATH="/usr/lib/girepository-1.0:/usr/local/lib/girepository-1.0:$AGS_DIR/astal-local/lib/linux/girepository-1.0:${GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$AGS_DIR/astal-local/lib/linux:${LD_LIBRARY_PATH}"

AGS_BIN="ags"
if [ -f "$HOME/.local/bin/ags" ]; then
    AGS_BIN="$HOME/.local/bin/ags"
fi

nohup "$AGS_BIN" run --gtk 4 . > /tmp/ags.log 2>&1 &
disown

echo "✅ Sistema Zenith estable."
