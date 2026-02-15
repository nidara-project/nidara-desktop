# MiDistroIA - El futuro de mi escritorio 💎

MiDistroIA es un entorno de escritorio (DE) personalizado basado en **Hyprland** y **AGS v3 (Aylur's Gtk Shell)**, diseñado para ser extremadamente rápido, visualmente premium y altamente optimizado sobre **Arch Linux**.

## 🚀 Características Clave
- **Compositor**: Hyprland (Wayland) para animaciones ultra-fluidas y tiling window management.
- **Shell**: AGS v3 (TypeScript/TSX) para una interfaz reactiva y moderna (Barra, Dock, Control Center).
- **Dock Premium**: Implementación nativa en AGS v3 con animaciones de magnificación.
- **AppGrid Inteligente**: Búsqueda difusa instantánea.
- **Control Center**: Gestión integrada de volumen (WirePlumber), brillo, red, batería y reproducción multimedia (MPRIS).
- **Modularidad**: Arquitectura desacoplada en TypeScript.

## 🛠️ Optimización y Rendimiento
- **AppGrid Optimization**: Implementación de sistema de caché.
- **Dock Physics**: Motor de magnificación centralizado.
- **Atomic Loading**: Los componentes del Control Center se cargan de forma atómica.

## 💿 Automatización & ISO
El proyecto incluye un script de aprovisionamiento robusto para **Arch Linux**:
- `provision.sh`: Automatiza la instalación de dependencias y compilación de librerías Astal.

## 🧑‍💻 Guía para Desarrolladores
1. Entrar en el directorio UI: `cd ui/ags-v3`
2. Instalar dependencias: `npm install`
3. Ejecutar en modo desarrollo: `ags run`
4. Recargar UI completa: `super + shift + c` (Ejecuta `scripts/reload_ui.sh`)

---
💎 **MiDistroIA** - *Performance, Aesthetics, Intelligence.*
