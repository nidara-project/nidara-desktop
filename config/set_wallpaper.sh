#!/bin/bash
# /scripts/set_wallpaper.sh

# 1. Definimos la base (Ajustada a tu ruta de desarrollo)
WALLPAPER_DIR="/home/angel/Pictures/Wallpapers"
DEFAULT_WALLPAPER="wallpaper.jpg"

# 2. Lógica de selección:
# Si escribes algo después del script, usa eso ($1). Si no, usa el default.
SELECTED=${1:-$DEFAULT_WALLPAPER}

# 3. Ejecución con SWWW (Estética MiDistroIA)
swww img "$WALLPAPER_DIR/$SELECTED" \
    --transition-type grow \
    --transition-fps 60 \
    --transition-pos "0.5,0.5" \
    --transition-duration 2
    

echo "Arquitecto: Fondo actualizado a $SELECTED"
