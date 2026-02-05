# MiDistroIA - El futuro de mi escritorio 💎

MiDistroIA es un entorno de escritorio (DE) personalizado basado en **Hyprland** y **AGS v3 (Aylur's Gtk Shell)**, diseñado para ser extremadamente rápido, visualmente premium y altamente optimizado.

## 🚀 Características Clave
- **Compositor**: Hyprland (Wayland) para animaciones ultra-fluidas y tiling window management.
- **Shell**: AGS v3 (TypeScript/TSX) para una interfaz reactiva y moderna.
- **Dock Premium**: Efecto de magnificación tipo macOS con física optimizada y modularizado para máximo rendimiento.
- **AppGrid Inteligente**: Búsqueda difusa instantánea con caché de widgets y filtrado por visibilidad.
- **Control Center**: Gestión integrada de volumen, brillo, red, batería y reproducción multimedia.
- **Modularidad**: Arquitectura desacoplada en TypeScript que facilita la personalización y mantenimiento.

## 🛠️ Optimización y Rendimiento
- **AppGrid Optimization**: Implementación de sistema de caché que evita la recreación de widgets, reduciendo el lag de búsqueda a cero.
- **Dock Physics**: Motor de magnificación centralizado en `DockPhysics.ts` para cálculos precisos y suaves.
- **Atomic Loading**: Los componentes del Control Center se cargan de forma atómica para evitar bloqueos del sistema.

## 💿 Automatización & ISO
El proyecto incluye un script de aprovisionamiento robusto:
- `provision.sh`: Automatiza la instalación de dependencias y compilación de librerías Astal. Ideal para personalización de ISOs en Ubuntu (usando Cubic).

## 🧑‍💻 Guía para Desarrolladores
1. Instalar dependencias base: `npm install`
2. Ejecutar en modo desarrollo: `npm run dev`
3. Configurar extensiones en `.vscode` para soporte total de TypeScript y TSX.

---
💎 **MiDistroIA** - *Performance, Aesthetics, Intelligence.*
