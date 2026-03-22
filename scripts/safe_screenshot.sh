#!/bin/bash
# safe_screenshot.sh - Clean environment wrapper for grim/slurp
# Fixes segfaults in nested Hyprland sessions by unsetting toxic variables

# Debug log
LOG="/tmp/screenshot_debug.log"
echo "--- $(date) ---" >> "$LOG"
echo "Original ENV:" >> "$LOG"
env | grep -E "LD_LIBRARY_PATH|GI_TYPELIB_PATH|WAYLAND" >> "$LOG"

# Limpiar variables conflictivas
unset LD_LIBRARY_PATH
unset GI_TYPELIB_PATH
unset SANDBOX_LD_LIBRARY_PATH

echo "Cleaned ENV:" >> "$LOG"
env | grep -E "LD_LIBRARY_PATH|GI_TYPELIB_PATH" >> "$LOG"

# Asegurar variables críticas
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

echo "Target Display: $WAYLAND_DISPLAY" >> "$LOG"

# Modo de uso
MODE="$1" # "copy" o "save"
FILE="$2"

# ENV -i ISOLATION
# IMPORTANTE: 
# 1. Pasar XDG_DATA_DIRS ESTÁNDAR (para que slurp encuentre cursores básicos).
# 2. Ignorar rutas custom (veneno).
# 3. Forzar PATH limpio.
# 4. NO PASAR HOME (evitar configs corruptas en ~/.config o ~/.icons).
SLURP_CMD="env -i PATH=/usr/local/bin:/usr/bin:/bin WAYLAND_DISPLAY=$WAYLAND_DISPLAY XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR XDG_DATA_DIRS=/usr/share:/usr/local/share slurp -d"

echo "Executing: $SLURP_CMD" >> "$LOG"

run_slurp() {
    # Ejecutamos slurp con entorno seguro (Sistema base SI, Custom NO, HOME NO)
    slurp_out=$(env -i PATH="/usr/local/bin:/usr/bin:/bin" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" XDG_DATA_DIRS="/usr/share:/usr/local/share" slurp -d 2>>"$LOG")
    slurp_exit=$?
    if [ $slurp_exit -ne 0 ]; then
        echo "SLURP FAILED with exit code $slurp_exit" >> "$LOG"
        # Debug: Mostrar por qué falló
        notify-send -u critical "Error" "Slurp falló ($slurp_exit). Revisa $LOG"
        exit 1
    fi
    echo "$slurp_out"
}

if [ "$MODE" == "copy" ]; then
    selection=$(run_slurp)
    grim -g "$selection" - | wl-copy 2>>"$LOG"
elif [ "$MODE" == "save" ]; then
    # Asegurar directorio
    mkdir -p "$(dirname "$FILE")"
    selection=$(run_slurp)
    grim -g "$selection" "$FILE" 2>>"$LOG"
    notify-send "Captura" "Guardada en $FILE"
else
    selection=$(run_slurp)
    grim -g "$selection" - | wl-copy 2>>"$LOG"
fi
