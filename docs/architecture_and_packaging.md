# Arquitectura y Estrategia de Empaquetado de MiDistroIA

Este documento define cómo estructuramos el código ahora (Desarrollo) y cómo se convertirá en una Distribución instalable (ISO) en el futuro.

## 1. El Concepto de las "Tres Capas"

Para evitar rehacer trabajo, separamos el sistema en tres niveles lógicos:

### Capa A: El Código Fuente (Donde estamos ahora)
*   **Ubicación**: `~/Dev/MiDistroIA`
*   **Función**: Aquí escribimos, probamos y rompemos cosas. Es el "taller".
*   **Estado**: Volátil, editable.

### Capa B: El Sistema Base (La "Distro")
*   **Ubicación Futura**: `/usr/lib/midistroia` (código Python), `/usr/share/midistroia` (assets/iconos), `/etc/xdg` (configuraciones globales).
*   **Función**: Cuando creamos la ISO, el código de "A" se copia aquí. Es inmutable para el usuario normal.
*   **Instalación**: Usaremos un script `install.sh` o crearemos un paquete `.deb` que tome todo lo de `~/Dev` y lo coloque en su sitio correcto del sistema.

### Capa C: La Configuración de Usuario (Tu `/home`)
*   **Ubicación**: `~/.config/hypr`, `~/.config/midistroia`, `~/.config/kitty`.
*   **Función**: Son los archivos que el usuario puede tocar.
*   **Estrategia "Skeleton"**:
    *   En la ISO, guardaremos tus configs "perfectas" en `/etc/skel/`.
    *   Cuando se crea un usuario nuevo en la ISO, Linux automáticamente copia `/etc/skel` a su `/home/nuevo_usuario`.
    *   ¡Así el usuario nuevo empieza con TU configuración exacta!

---

## 2. Flujo de Trabajo: De Código a ISO

No tienes que "volver a hacer" nada manual. El proceso será automatizado:

1.  **Freeze (Congelar)**: Cuando estemos contentos con el código, ejecutamos un script de empaquetado.
2.  **Build**:
    *   Compila lo que sea necesario (si hubiera C/Rust).
    *   Copia los scripts Python a `/usr/bin` (ej: `midistro-dock`).
    *   Mueve los archivos `.desktop` a `/usr/share/applications` (para que salgan en el menú de todos).
3.  **ISO Gen**: Usaremos herramientas estándar (como `cubic` o `archiso` dependiendo de la base) que toman una ISO virgen de Ubuntu/Debian e inyectan nuestro paquete `.deb`.

## 3. Estructura Actual vs Final

| Componente | En Desarrollo (`~/Dev`) | En Producción (ISO) |
| :--- | :--- | :--- |
| **Dock / Barra** | Ejecutamos `python main_dock.py` | Ejecutable `/usr/bin/midistro-dock` lanzado por systemd |
| **Configs Hypr** | `~/.config/hypr/hyprland.conf` | `/etc/skel/.config/hypr/hyprland.conf` |
| **Assets (Iconos)** | `ui/assets/` | `/usr/share/midistroia/assets/` |
| **Logs** | Consola / Terminal | journalctl (systemd) |

## 4. ¿Qué tienes que hacer tú?

Por ahora, **NADA diferente**. Sigue trabajando en `~/Dev` y en tu `~/.config`.
Cuando llegue el momento de la ISO, mi trabajo será crear un script que diga:
*"Toma este archivo de aquí y ponlo allí en el sistema"*.

¡Todo lo que estás haciendo ya es válido para la versión final!
