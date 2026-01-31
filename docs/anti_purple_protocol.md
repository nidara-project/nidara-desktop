# Protocolo "Cristal Puro" para DistroIA (AGS v3)

Este documento define la técnica oficial para lograr la transparencia absoluta y el blur perfecto en el Dock.

## 1. Lógica del Blur (Hyprland Skill)
Para que el desenfoque sea nítido y respire con el fondo, usamos la **Lógica de Alpha Inversa**:
- **Dibujo (Cairo)**: Opacidad del relleno fija en `0.12`.
- **Umbral (Hyprland)**: `ignore_alpha` fijo en `0.10`.
- **Efecto**: Hyprland "atrapa" el 12% de blanco y aplica el desenfoque sobre él, creando un cristal traslúcido real.

## 2. Sintaxis de Bloques (v0.53.3)
Es obligatorio usar la sintaxis de bloque para asegurar que todas las propiedades se apliquen correctamente:
```hyprland
layerrule {
  name = crystal-dock-glass
  match:namespace = crystal-dock
  ignore_alpha = 0.1
  blur = on
  xray = 1
}
```

## 3. Limpieza de Hardware (Dock.tsx)
Aunque el blur es la clave, mantenemos la transparencia de base en el código:
- `win.app_paintable = true`: Cede el control total del dibujo a Cairo.
- `win.input_shape_combine_region(null)`: Asegura que el buffer de GDK no oculte el canal alpha.

## 4. Refinamiento Óptico (macOS Level)
Para pasar de " cristal básico" a "premium", seguimos estos principios de física óptica:
- **Depth Gradient**: El fondo nunca es sólido. Usamos un `LinearGradient` (Top 0.16 -> Bottom 0.08) para dar peso visual.
- **Specular Highlight**: Una línea de luz superior de **1.5px** con opacidad **0.45** simula el reflejo de una fuente de luz cenital.
- **Vibrancy (Hyprland)**: Configuramos `vibrancy = 1.2` (Estándar) o `1.5` (Vivid) según preferencia, pero **SIEMPRE MANTENIENDO XRAY=1**.

## 5. La Ley de la Textura (Blur Passes)
**NUNCA superar los 3 pases de blur** para superficies de cristal principal.
- **3 Pases**: Conserva el "grano" y la textura de las ventanas traseras -> Cristal Físico.
- **5+ Pases**: Suaviza tanto que elimina la textura -> Efecto "Neblina" o Plástico (Percibido como error de renderizado).

---
*Este protocolo es la ley suprema del diseño en DistroIA. Cualquier componente nuevo (Waybar, SwayNC, etc.) debe someterse a estas reglas matemáticas de transparencia y profundidad.*

## 4. El Desafío del Dock: Lecciones Aprendidas
El Dock de AGS v3 ha sido el componente más complejo de calibrar debido a la interacción entre GTK y Hyprland:
- **Centrado Vertical**: Se logró mediante un contenedor `Box` con `vpack: "center"`, evitando que los iconos "bailaran" durante la magnificación.
- **Magnificación vs Layer Shell**: El mayor reto fue evitar que los iconos magnificados fueran recortados. La solución fue definir una `exclusive_zone` de `10px` pero permitir que la ventana real de GDK sea más grande, permitiendo el desbordamiento visual sin colisiones de layout.
- **Z-Index y Foco**: Se configuró como `layer: "top"` para garantizar que siempre esté visible sobre las ventanas, pero con reglas de blur que lo integran orgánicamente con el wallpaper.

---
*Este protocolo es la ley suprema del diseño en DistroIA. Cualquier componente nuevo (Waybar, SwayNC, etc.) debe someterse a estas reglas matemáticas de transparencia y profundidad.*
