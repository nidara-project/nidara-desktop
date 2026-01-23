#!/bin/bash

# Matar procesos anteriores
pkill -f main_topbar.py

# Esperar un poco
sleep 0.5

# Iniciar la top bar en segundo plano
python3 ~/Dev/MiDistroIA/ui/topbar/main_topbar.py > /dev/null 2>&1 &

echo "✨ MiDistroIA TopBar iniciada"
