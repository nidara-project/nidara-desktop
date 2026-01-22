#!/bin/bash

# 1. Deshabilitar el Dock de Ubuntu (GNOME Shell Extension)
echo "Deshabilitando Ubuntu Dock..."
gnome-extensions disable ubuntu-dock@ubuntu.com

# 2. Matar cualquier instancia previa de nuestro dock
echo "Deteniendo docks antiguos..."
pkill -f "main_dock.py"

# 3. Lanzar nuestro Dock personalizado
echo "Iniciando MiDistroIA Dock..."
python3 /home/angel/Dev/MiDistroIA/ui/dock/main_dock.py &

echo "¡Cambio realizado!"
