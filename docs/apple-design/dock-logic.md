# macOS Dock & TopBar Logic

Especificaciones técnicas para el comportamiento del Dock y la barra superior.

## 1. El Dock: Magnificación Parabólica
El efecto de agrandado al pasar el ratón sigue una curva gaussiana o parabólica:
- **Eje**: El icono bajo el cursor escala al 100% del tamaño máximo configurado.
- **Vecinos**: Los iconos adyacentes escalan proporcionalmente según su distancia al cursor.
- **Transición**: Debe ser suave (60fps) usando transformaciones de escala para no afectar el layout (layout-free scaling).

## 2. Barra Superior (Menubar)
- **Adaptabilidad**: Cambia entre modo claro/oscuro según el fondo (Vibrancy dinámica).
- **Material**: Usar el material `menu` (desenfoque alto, opacidad ~70%).
- **Espaciado**: Items con espaciado uniforme de 12px a 15px.

## 3. Menús Contextuales
- **Radio de Esquina**: 10px a 12px.
- **Separadores**: Líneas finas (0.5pt) con baja opacidad.
- **Efecto de Selección**: Fondo azul vibrante (`systemBlue`) con bordes redondeados dentro del menú.
