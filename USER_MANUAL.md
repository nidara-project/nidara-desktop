# 📔 MANUAL DE USUARIO - DISTROIA

Este documento es tu guía maestra para entender y controlar tu sistema. Aquí explicamos el "por qué" y el "cómo" de cada pieza para que no tengas que memorizarlo todo.

---

## 🚀 ATAJOS RÁPIDOS (Lo más importante)
| Acción | Atajo |
| :--- | :--- |
| **Recargar TODO (Barra, Fondo, Atajos)** | `SUPER` + `SHIFT` + `C` |
| **Cerrar Ventana** | `SUPER` + `Q` |
| **Menú de Aplicaciones (Grid)** | `SUPER` + `R` |
| **Abrir Terminal (Kitty)** | `SUPER` + `T` |
| **Ver este Manual** | `SUPER` + `H` |
| **Mover Ventana a Escritorio N** | `SUPER` + `SHIFT` + `[1-5]` |

---

## 🎨 PERSONALIZACIÓN

### Fondo de Pantalla
Estamos usando **swaybg** porque es la herramienta más estable para tu tarjeta gráfica.
- **Dónde cambiarlo**: Edita el archivo `~/.config/hypr/hyprland.conf`.
- **Línea a buscar**: `exec-once = swaybg -i /ruta/a/tu/imagen.jpg -m fill`
- **Para aplicar el cambio**: Pulsa `SUPER` + `SHIFT` + `C`.

### Barra Superior (Waybar)
- **Configuración**: `~/.config/waybar/config`
- **Estilo (Colores/CSS)**: `~/.config/waybar/style.css`

---

## ⚓ EL DOCK (Barra Inferior)
El Dock es una aplicación inteligente escrita en Python que se comunica con el sistema.
- **Auto-Hide**: Se oculta automáticamente si hay una ventana que le estorba. Pasa el ratón por la parte inferior para que aparezca.
- **Cerrar Apps**: Haz **clic derecho** sobre cualquier icono de una app abierta para ver la opción "Cerrar aplicación".
- **Indicadores**: Los puntos debajo de los iconos indican que la aplicación está abierta. Un punto brillante indica la ventana activa.

---

## 🛠️ RESOLUCIÓN DE PROBLEMAS (Troubleshooting)

### "El Dock no aparece"
Pulsa `SUPER` + `SHIFT` + `C`. Esto debería relanzar el script `scripts/start_dock.sh`.

### "Hay una aplicación que hace crashear el sistema (como Antigravity)"
Hemos implementado un **Lanzador de Seguridad**. Todas las apps se abren a través de `core/launcher.py`, que limpia las variables de entorno peligrosas antes de lanzarlas. Esto evita que las apps de desarrollo se confundan con el entorno Wayland del sistema.

### "He cambiado una tecla y no funciona"
Revisa `~/.config/hypr/hyprland.conf`. Es el corazón del sistema. Si cometes un error de sintaxis, Hyprland te avisará con una barra roja arriba.

---

## 🏗️ ARQUITECTURA TÉCNICA
- **Compositor**: Hyprland (Wayland).
- **Librería UI**: GTK4 + Gtk4LayerShell (para que el Dock y la Barra se peguen a los bordes).
- **Lanzador**: DistroIA Menu (Escrito por nosotros para ser rápido y limpio).
