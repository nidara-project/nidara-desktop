#!/bin/bash
LOG="$HOME/antigravity_debug.log"
echo "==========================================" >> "$LOG"
echo "LAUNCHER STARTED AT $(date)" >> "$LOG"
echo "ENV DUMP:" >> "$LOG"
env | grep -E "XDG|GDK|WAYLAND|DISPLAY|ozone" >> "$LOG"
echo "------------------------------------------" >> "$LOG"

# CRITICAL FIX: Sanitize Library Environment
# Prevent inheriting GTK4 Layer Shell preloads which crash Electron (Antigravity)
unset LD_PRELOAD
unset LD_LIBRARY_PATH
unset GI_TYPELIB_PATH
unset GDK_BACKEND
unset XDG_SESSION_TYPE

echo "Attempting Standard launch..." >> "$LOG"
# Intentar lanzar sin flags primero (a veces XWayland es lo mejor)
/usr/share/antigravity/antigravity "$@" >> "$LOG" 2>&1
EXIT_CODE=$?

echo "EXIT CODE: $EXIT_CODE" >> "$LOG"

if [ $EXIT_CODE -ne 0 ]; then
    echo "Standard launch failed. Trying explicit Wayland flags..." >> "$LOG"
    /usr/share/antigravity/antigravity --ozone-platform=wayland --enable-features=UseOzonePlatform "$@" >> "$LOG" 2>&1
    EXIT_CODE=$?
fi

if [ $EXIT_CODE -ne 0 ]; then
    echo "Wayland flags failed. Trying SAFE MODE (No GPU)..." >> "$LOG"
    # Último recurso: Desactivar aceleración por hardware (común en crashes de Electron)
    /usr/share/antigravity/antigravity --disable-gpu --disable-software-rasterizer "$@" >> "$LOG" 2>&1
fi
echo "==========================================" >> "$LOG"
