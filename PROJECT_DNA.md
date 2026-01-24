# PROJECT_DNA: DistroIA
**Identidad Inmutable y Reglas Maestras**

Este documento define la esencia de **DistroIA** (antes MiDistroIA). Cualquier agente trabajando en este proyecto debe respetar estas directrices sagradas.
 El historial de este repo ha sido restaurado tras un desastre de sincronización; respeta estas reglas.

## 1. Identidad Técnica Inamovible
- **Entorno**: X.org (GNOME sobre X11). **NO** Wayland/LayerShell.
- **UI Architecture**: Python Gtk4 + wmctrl/xprop para posicionamiento de Dock y TopBar.
- **Visuals**: Dock Orgánico con **indicadores (dots)** de estado (Cyberpunk/Catppuccin theme).
- **Lanzador**: `wofi --show drun`.

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
