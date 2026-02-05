# MiDistroIA: Especificaciones de Estructura Base 💎

## Arquitectura de Capas:
- **Nivel 0 (Kernel/Base):** Ubuntu 24.04 / MiDistroIA Core.
- **Nivel 1 (Compositor):** Hyprland (Wayland) con Gtk4LayerShell.
- **Nivel 2 (UI Components):** Shell unificado desarrollado en **AGS v3 (TypeScript/TSX)**.

## Estado de la Base:
- [x] Estructura de carpetas profesional.
- [x] Motor de temas basado en CSS dinámico.
- [x] Lógica de anclaje de sistema (Layer Shell) configurada en AGS.
- [x] Optimización de rendimiento (Caching de widgets).
- [ ] Integración profunda de Agentes de IA (Próxima fase).

## Notas Técnicas:
- **UI Framework**: GJS + GTK4 vía AGS v3.
- **Modularidad**: Componentes desacoplados para facilitar el despliegue en diferentes ISOs.
- **Performance**: Puntos de entrada optimizados y minimización de re-renders.
