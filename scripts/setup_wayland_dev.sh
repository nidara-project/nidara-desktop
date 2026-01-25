# 1. Asegurar dependencias de compilación y GTK4
echo "📦 Instalando dependencias de construcción..."
sudo apt-get update
sudo apt-get install -y \
    meson \
    ninja-build \
    git \
    libgtk-4-dev \
    libwayland-dev \
    wayland-protocols \
    gobject-introspection \
    libgirepository1.0-dev \
    valac

# 2. Compilar e Instalar gtk4-layer-shell (si no existe)
if ! pkg-config --exists gtk4-layer-shell-0; then
    echo "⚙️ Compilando gtk4-layer-shell desde fuente..."
    git clone https://github.com/wmww/gtk4-layer-shell.git /tmp/gtk4-layer-shell
    cd /tmp/gtk4-layer-shell
    meson setup build
    ninja -C build
    sudo ninja -C build install
    sudo ldconfig # Actualizar caché de librerías
    cd -
    rm -rf /tmp/gtk4-layer-shell
else
    echo "✅ gtk4-layer-shell ya está instalado."
fi

# 3. Preparar Instalador de Hyprland (JaKooLit)
if ! command -v Hyprland &> /dev/null; then
    echo "⚠️ Hyprland no detectado. Preparando instalador comunitario (JaKooLit)..."
    
    INSTALLER_DIR="$HOME/Dev/MiDistroIA/temp_deps/Ubuntu-Hyprland"
    mkdir -p "$HOME/Dev/MiDistroIA/temp_deps"
    
    if [ ! -d "$INSTALLER_DIR" ]; then
        git clone --depth 1 -b 24.04 https://github.com/JaKooLit/Ubuntu-Hyprland.git "$INSTALLER_DIR"
    fi
    
    chmod +x "$INSTALLER_DIR/install.sh"
    
    echo "READY TO INSTALL:"
    echo "⚠️  Por favor, ejecuta el siguiente comando MANUALMENTE para instalar Hyprland:"
    echo "    $INSTALLER_DIR/install.sh"
    echo ""
    echo "Nota: El script te pedirá confirmaciones. Puedes decir 'No' a los 'Dotfiles' si solo quieres el motor."
else
    echo "✅ Hyprland ya está instalado."
fi

echo "🎉 Dependencias de DistroIA listas. Cuando tengas Hyprland, corre 'scripts/test_wayland.sh'."
