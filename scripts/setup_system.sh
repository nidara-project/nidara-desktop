#!/bin/bash
echo "🔧 Configurando entorno base para MiDistroIA..."
sudo apt update
sudo apt install -y python3-gi python3-gi-cairo gir1.2-gtk-4.0 gir1.2-wnck-3.0
# Aquí añadiremos más configuraciones de sistema más adelante
