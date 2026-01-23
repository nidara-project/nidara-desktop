#!/bin/bash
# MiDistroIA Installer Script - Hyprland Edition
# Sistema operativo nativo de IA con efectos visuales premium

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║       MiDistroIA - Instalador (Hyprland Edition)          ║"
echo "║   Sistema operativo nativo de IA con Glassmorphism        ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# 1. Añadir PPA de Hyprland
echo -e "${YELLOW}[1/6] Añadiendo repositorio de Hyprland...${NC}"
sudo add-apt-repository -y ppa:cppiber/hyprland
sudo apt update

# 2. Instalar Hyprland y dependencias
echo -e "${YELLOW}[2/6] Instalando Hyprland y dependencias...${NC}"
sudo apt install -y hyprland foot wofi wl-clipboard grim slurp

# 3. Instalar dependencias de Python para el Dock
echo -e "${YELLOW}[3/6] Verificando dependencias de Python...${NC}"
sudo apt install -y python3-gi python3-gi-cairo gir1.2-gtk-4.0

# 4. Configurar Hyprland para el usuario
echo -e "${YELLOW}[4/6] Configurando Hyprland...${NC}"
mkdir -p ~/.config/hypr

# 5. Crear enlace simbólico para desarrollo fácil
rm -f ~/.config/hypr/hyprland.conf
ln -sf ~/Dev/MiDistroIA/config/hypr/hyprland.conf ~/.config/hypr/hyprland.conf

# 6. Registrar sesión en GDM
echo -e "${YELLOW}[5/6] Registrando sesión MiDistroIA...${NC}"
sudo cp ~/Dev/MiDistroIA/config/midistroia.desktop /usr/share/wayland-sessions/midistroia.desktop

echo -e "${YELLOW}[6/6] Limpiando...${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ¡Instalación completada!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Próximos pasos:${NC}"
echo "  1. Cierra sesión (Log out)"
echo "  2. En la pantalla de login, haz clic en el icono de engranaje"
echo "  3. Selecciona 'MiDistroIA'"
echo "  4. Inicia sesión"
echo ""
echo -e "${CYAN}Atajos importantes:${NC}"
echo "  Super + Enter     → Terminal"
echo "  Super + D         → Launcher (wofi)"
echo "  Super + Q         → Cerrar ventana"
echo "  Super + F         → Pantalla completa"
echo "  Super + 1-5       → Cambiar workspace"
echo "  Super + Shift + E → Salir de MiDistroIA"
echo ""
echo -e "${CYAN}Características visuales activas:${NC}"
echo "  ✓ Blur (Glassmorphism)"
echo "  ✓ Esquinas redondeadas (15px)"
echo "  ✓ Sombras suaves"
echo "  ✓ Animaciones fluidas"
echo "  ✓ Gradientes en bordes activos"
echo ""
