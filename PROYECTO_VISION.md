# MiDistroIA: Especificaciones de Estructura Base

## Arquitectura de Capas:
- **Nivel 0 (Kernel/Base):** Ubuntu 22.04 Headless.
- **Nivel 1 (Compositor):** Wayland con Gtk4LayerShell.
- **Nivel 2 (UI Components):** Dock y Menús desarrollados en Antigravity (Python/GTK4).

## Estado de la Base:
- [x] Estructura de carpetas profesional.
- [x] Motor de temas centralizado (theme.json).
- [x] Lógica de anclaje de sistema (Layer Shell) configurada.
- [ ] Integración de Agentes de IA (Siguiente fase).

## Notas Técnicas:
- No usar decoraciones de ventana (CSD) para componentes de sistema.
- Toda la UI debe consultar `/config/theme.json` antes de renderizar.
