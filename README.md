# Crystal Shell - El futuro de mi escritorio 💎

Crystal Shell es un entorno de escritorio (DE) personalizado basado en **Hyprland** y **AGS v3 (Aylur's Gtk Shell)**, diseñado para ser extremadamente rápido, visualmente premium y altamente optimizado sobre **Arch Linux**.

## 🚀 Características Clave
- **Compositor**: Hyprland (Wayland) para animaciones ultra-fluidas y tiling window management.
- **Shell**: AGS v3 (TypeScript/TSX) para una interfaz reactiva y moderna (Barra, Dock, Control Center).
- **Dock Premium**: Implementación nativa en AGS v3 con animaciones de magnificación.
- **AppGrid Inteligente**: Búsqueda difusa instantánea.
- **Control Center**: Gestión integrada de volumen (WirePlumber), brillo, red, batería y reproducción multimedia (MPRIS).
- **Modularidad**: Arquitectura desacoplada en TypeScript.

## 🛠️ Optimización y Rendimiento
- **AppGrid Optimization**: Implementación de sistema de caché.
- **Dock Physics**: Motor de magnificación centralizado.
- **Atomic Loading**: Los componentes del Control Center se cargan de forma atómica.

## 💿 Instalación (Usuarios)
El proyecto incluye un script de aprovisionamiento robusto para **Arch Linux** que configura todo el sistema (SDDM, Hyprland, Audio, UI) automáticamente.

1.  **Clonar Repo**: `git clone https://github.com/aalonx/Crystal Shell.git ~/.config/crystal-shell`
2.  **Ejecutar Script**:
    ```bash
    cd ~/.config/crystal-shell
    ./install.sh
    ```
3.  **Iniciar Sesión**: Reinicia el equipo **O** ejecuta `sudo systemctl start sddm` para entrar en el entorno gráfico.

---

## ⌨️ Atajos Clave (Hyprland)
| Atajo | Acción |
| :--- | :--- |
| `Super + Q` | Cerrar ventana activa |
| `Super + T` | Abrir Terminal (Kitty) |
| `Super + E` | Abrir Archivos (Thunar) |
| `Super + R` | Abrir Lanzador de aplicaciones |
| `Super + Shift + C` | **Recargar UI Completa (AGS + Hyprland)** |
| `Super + D` | Mostrar/Ocultar AppGrid |

---

## 🧑‍💻 Guía para Desarrolladores
### Estructura del Proyecto
La lógica de la interfaz (AGS v3) se encuentra en `ui/ags-v3/`:

-   **`widget/bar/`**: Barra superior, controles AI y esquemáticos.
-   **`widget/dock/`**: Dock inteligente con física de magnificación.
-   **`widget/control-center/`**: Panel de control y notificaciones.
-   **`widget/app-grid/`**: Rejilla de aplicaciones.
-   **`widget/overview/`**: Visión general de espacios de trabajo.
-   **`styles/`**: Estilos SCSS modulares.

### Comandos de Desarrollo
1.  Entrar en `ui/ags-v3`: `cd ui/ags-v3`
2.  Instalar dependencias: `npm install`
3.  Modo ejecución: `ags run`

---
💎 **Crystal Shell** - *Performance, Aesthetics, Intelligence.*
