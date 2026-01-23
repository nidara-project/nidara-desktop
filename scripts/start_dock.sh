#!/bin/bash
# Script para lanzar el Dock de MiDistroIA en GNOME/X11

# Matar instancias previas
pkill -f "main_dock.py"
pkill -f "monitor.py"

# Esperar un momento
sleep 1

# Export locales to ensure Python doesn't complain
export LC_ALL=es_ES.UTF-8
export LANG=es_ES.UTF-8

# Lanzar el monitor (Nota: ahora main_dock.py lo lanza internamente, 
# pero si preferimos desacoplarlo podríamos dejarlo. 
# El nuevo código de main_dock.py lo lanza como subproceso, así que NO lo lanzamos aquí para evitar duplicados)

# Lanzar el dock
python3 ~/Dev/MiDistroIA/ui/dock/main_dock.py &

echo "✨ MiDistroIA Dock iniciado"
