# Especificación de Componentes UI

Detalles técnicos para la implementación de los widgets principales en AGS.

## 1. Topbar (Menubar)
- **Posición**: Superior, extendida al 100% o flotante (estilo isla).
- **Widgets**:
  - `Workspaces`: Indicadores de estado de Hyprland.
  - `Clock`: Formato minimalista.
  - `Systray`: Iconos de sistema con espaciado uniforme.
- **Efecto**: `backdrop-filter: blur(20px)` con borde sutil de 1px RGBA.

## 2. El Dock (Aplicaciones)
- **Comportamiento**: Auto-hide por defecto.
- **Efecto de Escala**: Implementar lógica de magnificación gaussiana en el evento `hover`.
- **Lógica Detallada**: Ver [DOCK_SPEC.md](file:///home/angel/Dev/MiDistroIA/docs/ui/DOCK_SPEC.md) para parámetros físicos y geométricos (V135).
- **Indicadores**: Puntos sutiles bajo los iconos para apps abiertas (estilo macOS).

## 3. Centro de Control
- **Diseño**: Grid de 2x2 para controles rápidos (Wifi, Bluetooth, Brillo, Audio).
- **IA Integration**: Espacio dedicado para un prompt rápido de IA que se comunique con el servicio local (Ollama/LocalAI).
