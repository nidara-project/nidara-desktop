# Guía de Configuración Crystal Shell

En **Crystal Shell** (basada en Hyprland), la configuración se divide en dos partes principales. Aquí tienes qué herramienta usar para cada cosa:

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
| **Transparencia/Opacidad** | `~/.config/hypr/hyprland.conf` (sección `decoration`) |
| **Animaciones** | `~/.config/hypr/hyprland.conf` (sección `animations`) |
| **Fondo de Pantalla** | `~/.config/hypr/hyprland.conf` (busca `exec-once = swaybg`) |
| **Barra Superior** | `~/.config/waybar/config` y `style.css` |
| **Iconos y Tema Oscuro** | Herramienta `nwg-look` (recomendado) o archivos GTK. |

## Resumen
*   **Hardware/Sistema** -> **Ajustes de Ubuntu**
*   **Ventanas/Visual** -> **Archivos de Texto**
## 3. Ejemplos Rápidos

### Cambiar Fondo de Pantalla 🖼️
1. Abre `~/.config/hypr/hyprland.conf`.
2. Busca la línea:
   ```bash
   exec-once = swaybg -i /ruta/a/tu/imagen.jpg -m fill
   ```
3. Cambia la ruta por la de tu imagen y guarda.
4. Recarga Hyprland (`Super + Shift + C`).
### Personalización de Terminal (Kitty & Fastfetch) 🐱

#### Arreglar Iconos Raros (Kanjis/Cuadrados)
Si ves símbolos extraños en lugar de iconos, es porque falta la **Nerd Font**.
1. Asegúrate de tener instalada `JetBrainsMono Nerd Font`.
2. En `~/.config/kitty/kitty.conf`:
   *   Usa `font_family JetBrainsMono Nerd Font` (sin "Mono") para iconos grandes y bonitos.
   *   Usa `... Nerd Font Mono` si prefieres que los iconos sean del mismo ancho que las letras (más pequeños).

#### Cambiar el Logo de Información (Fastfetch)
Para cambiar el logo que sale al abrir la terminal:
1. Edita `~/.config/fastfetch/config.jsonc`.
2. Busca la sección `"logo"`.
3. Cambia `"source"` por:
   *   `"source": "ubuntu"` (Logo clásico)
   *   `"source": "windows"` (Broma)
   *   `"source": "/ruta/a/imagen.png"` (Imagen personalizada)
