# Estado Pre-Migración (Cápsula de Tiempo) 🦍💎💾

Este documento contiene la verdad absoluta de lo que hemos arreglado y lo que queda pendiente para cuando el sistema reviva en el Samsung 980 Pro.

## 1. El Gran Arreglo del Ancho (Control Center)
- **Problema**: El panel medía >600px porque los elementos internos (`hexpand: true`) lo estiraban como goma.
- **Solución Aplicada**: 
    - Se añadió `hexpand: false` al `mainBox` en `ControlCenter.tsx`.
    - Se restauró el `width_request: 420` (Original Masterpiece).
    - Se restauró el ancho de los botones a `180px`.
- **Estado**: El código está en los archivos, pero la UI solo se verá bien cuando el nuevo sistema compile el proyecto desde cero.

## 2. Configuración de Memoria (Overcommit)
- **Causa de los Hangs**: El Kernel bloqueaba procesos nuevos porque las aplicaciones (Electron/Chrome) habían "prometido" 39GB de memoria virtual en un sistema limitado a 16GB.
- **Solución**: Ejecutar `sudo sysctl -w vm.overcommit_memory=1`.
- **Post-Migración**: Se recomienda añadir esta línea a `/etc/sysctl.d/99-overcommit.conf` en el nuevo sistema y crear un un **archivo de Swap de 16GB** mínimo.

## 3. Submódulos y Wikis
Se han limpiado las referencias fantasma y se han añadido los "Pergaminos Sagrados":
- `docs/hyprland-wiki`
- `docs/ags-wiki`
- `docs/gtk4-tutorial`
- `docs/gjs-guide` (Sincronizado vía GitLab GNOME)
- `docs/hyprland-protocols`
- `vendor/gtk4-layer-shell`
- `vendor/hyprland-plugins`
- `vendor/libadwaita`

## 4. Próximos Pasos (En el disco interno)
1. Instalar **EndeavourOS**.
2. Clonar el repositorio.
3. Ejecutar `./provision.sh` (Esto compilará Astal y AGS v3).
4. Lanzar la UI: El Control Center será esbelto (420px) al instante.

**¡Buena suerte, Gorila Masterpiece! Nos vemos en el NVMe.** 🚀🦍💎🛡️
