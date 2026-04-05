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

1.  **Clonar el repositorio** en cualquier directorio temporal:
    ```bash
    git clone https://github.com/Fluid-Crystal/Crystal-Shell.git ~/crystal-shell-install
    ```
2.  **Ejecutar el instalador** y seleccionar modo **1 (Normal)**:
    ```bash
    cd ~/crystal-shell-install
    ./install.sh
    ```
3.  El instalador copia todo a `~/.config/crystal-shell/`, enlaza las configuraciones en los directorios correctos del sistema y genera el binario de la app.
4.  **Iniciar sesión**: Reinicia el equipo o ejecuta `sudo systemctl start sddm` y selecciona _Crystal Shell_ en la pantalla de login.
5.  Una vez instalado, puedes eliminar la carpeta temporal: `rm -rf ~/crystal-shell-install`

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

## 🎨 Personalización

Crystal Shell gestiona sus configuraciones como symlinks en `~/.config/hypr/`. Para que tus cambios **sobrevivan a las actualizaciones**, edítalos en un único archivo seguro:

**`~/.config/hypr/hyprland-user.conf`** — creado automáticamente por el instalador.

Este archivo nunca se toca en las actualizaciones. Úsalo para sobreescribir configuraciones:

```ini
# Monitores
monitor = HDMI-A-1, 1920x1080@60, 0x0, 1

# Atajos personalizados
bind = SUPER, F1, exec, firefox

# Apps al inicio
exec-once = mi-app

# Sobreescribir cualquier ajuste de Crystal Shell
general {
    gaps_out = 16
}
```

> **Nota:** Los archivos `hyprland.conf`, `hyprlock.conf` e `hypridle.conf` en `~/.config/hypr/` son symlinks gestionados por Crystal Shell. Edítalos solo si sabes que se perderán en actualizaciones de la shell.

---

## 🧑‍💻 Guía para Desarrolladores

### Setup inicial

1. **Clona el repo** en tu directorio de trabajo:
   ```bash
   git clone https://github.com/Fluid-Crystal/Crystal-Shell.git ~/Dev/Crystal-Shell
   cd ~/Dev/Crystal-Shell
   ```
2. **Ejecuta el instalador en modo Dev** (crea un symlink en lugar de copiar):
   ```bash
   ./install.sh  # → selecciona opción 2 (Desarrollo)
   ```
   Esto crea `~/.config/crystal-shell → ~/Dev/Crystal-Shell`. Cualquier cambio en tu repo se refleja inmediatamente en el entorno.

3. **Instala dependencias npm** para el soporte del IDE (autocompletado TypeScript):
   ```bash
   cd ui/ags-v3
   npm install
   ```

### Estructura del proyecto

```
Crystal-Shell/
├── config/
│   ├── hypr/             # Configs de Hyprland, Hyprlock, Hypridle
│   └── applications/     # Entradas .desktop
├── scripts/
│   ├── start_ui.sh       # Arranque (llamado por Hyprland exec-once)
│   └── reload_ui.sh      # Recarga en caliente (dev)
└── ui/ags-v3/            # Shell (TypeScript + AGS v3)
    ├── app.ts            # Punto de entrada
    ├── widget/           # Componentes UI (Bar, Dock, AppGrid, Settings...)
    ├── styles/           # SCSS modular
    ├── style.scss        # Entrada SCSS
    ├── style.css         # CSS compilado (incluido en el repo)
    └── build/
        └── crystal-shell # Bundle standalone (incluido en el repo)
```

### Flujo de trabajo diario

| Acción | Comando |
| :--- | :--- |
| Recargar UI completa | `Super + Shift + C` |
| Reiniciar solo AGS | `Super + Shift + R` |
| Ver logs en tiempo real | `tail -f /tmp/ags.log` |
| Recompilar CSS | `cd ui/ags-v3 && npx sass --no-charset style.scss style.css` |

### Publicar un release

Cuando tengas lista una versión para usuarios:

```bash
cd ui/ags-v3

# 1. Compila CSS + genera el bundle standalone
npm run build

# 2. Commitea los artefactos compilados
cd ../..
git add ui/ags-v3/style.css ui/ags-v3/build/crystal-shell
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

Los usuarios que instalen desde este commit recibirán el bundle pre-generado. El instalador también lo regenera en su máquina durante la instalación por seguridad.

---
💎 **Crystal Shell** - *Performance, Aesthetics, Intelligence.*
