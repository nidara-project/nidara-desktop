# PROJECT_DNA: DistroIA
**Identidad Inmutable y Reglas Maestras**

Este documento define la esencia de **DistroIA** (antes MiDistroIA). Cualquier agente trabajando en este proyecto debe respetar estas directrices sagradas.
 El historial de este repo ha sido restaurado tras un desastre de sincronización; respeta estas reglas.

## 1. Identidad Técnica Inamovible (Actualizada 28/01/2026 - Era AGS)
- **Entorno**: Wayland (Compositor: **Hyprland**).
- **Base OS**: EndeavourOS (Arch Linux).
- **UI Architecture**: **AGS v3 (Aylur's GTK Shell)** usando TypeScript/TSX.
  - *Motivo del cambio*: Superación de limitaciones de Python Gtk4 (estabilidad, gestión de capas, complejidad de widgets).
- **Hyprland v0.53.3 compatibility**: Requiere sintaxis de bloque con nombre (`layerrule { name = '...' ... }`) para efectos de capa (blur).
- **Visuals**: Dock Orgánico (Glassmorphism) inspirado en macOS pero con identidad propia.
- **Indicadores**: Estilo **"Pill" (Pastilla)**, no puntos. Diferenciación clave para evitar el efecto "copia barata".
- **Icon Theme**: **Theme-Agnostic**. El sistema DEBE respetar y adaptarse al tema de iconos configurado por el usuario (gtsettings/nwg-look). 
  - *Prohibido*: Hardcodear nombres de iconos específicos de un paquete (ej. Reversal) si no son estándar (Freedesktop).
  - *Fallback*: Usar nombres estándar (ej. `utilities-terminal` en vez de `kitty` si este último falla).
- **Lanzador**: AGS AppLauncher (Objetivo) & `wofi --show drun` como backup legado.
- **Fondo de Pantalla**: Gestionado por **swaybg** (Solución estable que no requiere permisos de GPU).

## 2. El Historial de Oro (Source of Truth)
El historial legítimo del proyecto fue rescatado el 24/01/2026. 
- **Punto de Oro**: Commit `4f72e9b` (y sus hijos recuperados).
- **Prohibición**: Nunca realices un `git init` o un `force push` que altere estos commits antiguos. Cualquier sincronización con GitHub debe hacerse limpiando archivos pesados, nunca borrando la historia.

## 3. Reglas de Comportamiento del Agente
1. **Verificar antes de actuar**: Si el Dock no se ve "Premium", no lo redesines. Verifica que el CSS esté cargando y que `wmctrl` esté posicionando la ventana.
2. **Contexto Persistente**: Los planes de implementación y tareas deben guardarse en `.antigravity/` dentro de este repo, no solo en la carpeta volátil de la IA.
3. **Fidelidad**: Si el usuario dice que "lo hemos perdido todo", sospecha de un fallo de sincronización y busca en los backups locales o en el historial del editor antes de declarar el código como nuevo.

---
*Este documento es la garantía de que MiDistroIA nunca volverá a empezar de cero por un error de IA.*
