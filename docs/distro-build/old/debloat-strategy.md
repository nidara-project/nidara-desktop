# Estrategia de Minimalismo: Purga y Optimización de Ubuntu

Este documento define el protocolo técnico para transformar una base Ubuntu en el núcleo ligero de Crystal Shell.

## 1. Protocolo Anti-Snap (Prioridad Máxima)
Snap es considerado un "bug" en Crystal Shell. Su eliminación debe ser total y persistente.

### Eliminación:
1. Detener servicios: `sudo systemctl disable --now snapd.service snapd.socket snapd.seeded.service`.
2. Purga de paquetes: `sudo apt autoremove --purge snapd`.
3. Limpieza de directorios: `rm -rf ~/snap /var/snap /var/lib/snapd /var/cache/snapd`.

### Bloqueo Permanente (APT Pinning):
Crear `/etc/apt/preferences.d/nosnap.pref`:
```text
Package: snapd
Pin: release a=*
Pin-Priority: -10
```

## 2. Purga de Entorno Gráfico Base
Ubuntu Desktop viene con GNOME y X11. Crystal Shell utiliza Wayland/Hyprland exclusivamente.

### Eliminación de Bloat UI:
- Remover `gdm3`, `gnome-shell`, y aplicaciones `gnome-*`.
- Remover servidores Xorg si no se requiere retrocompatibilidad extrema.
- Mantener solo bibliotecas esenciales de GTK4 y Qt6.

## 3. Optimización del Kernel y Systemd
Para una experiencia "premium" necesitamos baja latencia.

### Kernel Sugerido:
- **XanMod Kernel**: Optimizado para escritorio, baja latencia y alto throughput.
- **Liquorix**: Excelente alternativa para gaming y multimedia en tiempo real.

### Servicios a Deshabilitar:
- `apport.service` (informes de error).
- `whoopsie.service`.
- `update-notifier.service`.
- Servicios de telemetría de Ubuntu.

## 4. Repositorios de Reemplazo
- **Flatpak**: Sustituto oficial de Snap para apps de usuario.
- **PPA/Nala**: Uso de `nala` como frontend de APT para descargas paralelas y mejor UI.
