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

## ⚙️ GESTIÓN DE CONFIGURACIÓN

En DistroIA trabajamos con dos niveles de archivos para que nada se pierda nunca:

1.  **NIVEL USUARIO (EN VIVO)**: Se encuentra en `~/.config/`.
    - Es lo que el sistema lee **realmente** para funcionar.
    - Si cambias algo aquí y pulsas `SUPER + SHIFT + C`, lo verás aplicado al momento.
2.  **NIVEL PROYECTO (SOURCE OF TRUTH)**: Se encuentra en `~/Dev/MiDistroIA/config/`.
    - Es nuestra "Copia de Oro". Está protegida por **Git**.
    - Sirve para que, si rompes algo en tu carpeta de usuario o el PC falla, podamos restaurar todo en un segundo desde el repositorio.

**¿Cómo los mantenemos sincronizados?**
Cada vez que terminamos un cambio exitoso, yo (tu asistente) copio los archivos desde tu nivel de usuario al nivel de proyecto y hago un `git push`. Así, tu configuración personal se convierte en la nueva configuración estándar de la distro.

---

---

## ⚓ EL DOCK (Barra Inferior)
El Dock es una aplicación inteligente desarrollada en **AGS v3**. 
- **Efecto de Magnificación**: Los iconos crecen dinámicamente al pasar el ratón, siguiendo una física de interpolación lineal para máxima suavidad.
- **Gestión de Pinned Apps**: Puedes fijar o desanclar aplicaciones directamente.
- **Indicadores de Estado**: Puntos de estilo premium indican si una aplicación está activa o tiene ventanas abiertas.

---

## 🎛️ CENTRO DE CONTROL
El Centro de Control (`SUPER + O` o clic en el icono de la barra) permite gestionar:
- **Sliders rápidos**: Ajuste instantáneo de Volumen y Brillo.
- **Conectividad**: Estado y toggle de Wi-Fi y Bluetooth (si las librerías están presentes).
- **Media Player**: Control de reproducción MRPIS (Play/Pause, Prev/Next) con visualización de carátulas.

---

## 🛠️ RESOLUCIÓN DE PROBLEMAS (Troubleshooting)

### "El fondo de pantalla no se ve o sale negro"
Actualmente estamos usando **swaybg** por estabilidad.
> [!IMPORTANT]
> Si deseas usar `hyprpaper`, asegúrate de estar en el grupo `video` y `render`.

### "No aparecen los iconos de Red o Batería"
Esto sucede si las librerías **Astal** no están instaladas o no se encuentran en el `GI_TYPELIB_PATH`.
- Revisa el archivo `package.json` para asegurar que las rutas `/usr/local/lib/...` están presentes o usa `provision.sh`.

---

## 🏗️ ARQUITECTURA TÉCNICA
- **Compositor**: Hyprland (Wayland).
- **Librería UI**: AGS v3 (GJS + GTK4 + Gtk4LayerShell).
- **Optimización**: Widget caching y physics engine personalizado en TypeScript.
- **Provisión**: Script `provision.sh` para instalación rápida de dependencias.
