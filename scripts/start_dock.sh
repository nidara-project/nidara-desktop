#!/bin/bash
# Script para lanzar el Dock de MiDistroIA en GNOME/X11

# Matar instancias previas
pkill -f "main_dock.py"
pkill -f "monitor.py"

# Esperar un momento
sleep 1

# Lanzar el monitor (en background)
python3 ~/Dev/MiDistroIA/monitor.py &

# Lanzar el dock
python3 ~/Dev/MiDistroIA/ui/dock/main_dock.py &

echo "✨ MiDistroIA Dock iniciado"
