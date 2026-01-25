# Guía de Configuración DistroIA

En **DistroIA** (basada en Hyprland), la configuración se divide en dos partes principales. Aquí tienes qué herramienta usar para cada cosa:

## 1. Usar "Ajustes de Ubuntu" (Panel Gráfico) 🛠️
Usa el botón derecho en el Dock -> **Ajustes** para configurar todo lo relacionado con el **hardware y el sistema base**:

*   **Wi-Fi y Bluetooth**: Conectar redes y dispositivos.
*   **Sonido**: Elegir altavoces y micrófono (aunque Waybar ya permite controlar volumen).
*   **Usuarios**: Crear cuentas, cambiar contraseñas.
*   **Región e Idioma**: Cambiar el idioma del sistema.
*   **Impresoras**: Añadir impresoras.
*   **Accesibilidad**: Opciones de visión/oído (algunas pueden no funcionar en Wayland).
*   **Energía**: Tiempos de suspensión/apagado.

## 2. Usar Archivos de Configuración (Hyprland) ⚙️
Para todo lo **visual y de comportamiento de ventanas**, debes editar los archivos en `~/.config/`:

| Qué quieres cambiar | Dónde está |
| :--- | :--- |
| **Atajos de Teclado** | `~/.config/hypr/hyprland.conf` |
| **Resolución de Pantalla** | `~/.config/hypr/hyprland.conf` (sección `monitor`) |
| **Bordes y Colores** | `~/.config/hypr/hyprland.conf` (sección `general`) |
| **Animaciones** | `~/.config/hypr/hyprland.conf` (sección `animations`) |
| **Fondo de Pantalla** | `~/.config/hypr/hyprpaper.conf` |
| **Barra Superior** | `~/.config/waybar/config` y `style.css` |
| **Iconos y Tema Oscuro** | Herramienta `nwg-look` (recomendado) o archivos GTK. |

## Resumen
*   **Hardware/Sistema** -> **Ajustes de Ubuntu**
*   **Ventanas/Visual** -> **Archivos de Texto**
