# Crystal Shell: Especificaciones de Estructura Base 💎

## Arquitectura de Capas:
- **Nivel 0 (Kernel/Base):** Arch Linux / EndeavourOS.
- **Nivel 1 (Compositor):** Hyprland (Wayland) con Gtk4LayerShell.
- **Nivel 2 (UI Components):** Shell unificado desarrollado en **AGS v3 (TypeScript/TSX)**.

## Estado de la Base:
- [x] Estructura de carpetas profesional (Monorepo AGS).
- [x] Motor de temas basado en CSS dinámico (SCSS).
- [x] Lógica de anclaje de sistema (Layer Shell) con protección de menús.
- [x] Optimización de rendimiento y monitores de sistema.
- [x] Central de control con selección de audio y Bluetooth.
- [/] Integración profunda de Agentes de IA (Próxima fase).

## Notas Técnicas:
- **UI Framework**: GJS + GTK4 vía AGS v3 (Astal).
- **Modularidad**: Componentes desacoplados en TypeScript.
- **Performance**: Puntos de entrada optimizados y minimización de re-renders.
