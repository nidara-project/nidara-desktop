# Arquitectura y Estrategia de Empaquetado de MiDistroIA 🛡️📦💎

Este documento define cómo estructuramos el código ahora (Desarrollo) y cómo se convertirá en una Distribución instalable (ISO).

## 1. El Concepto de las "Tres Capas"

### Capa A: El Código Fuente (Entorno de Desarrollo)
*   **Ubicación**: `~/Dev/MiDistroIA`
*   **Tecnología**: Ags v3 (TypeScript), Hyprland Config.
*   **Flujo**: Los cambios se aplican instantáneamente mediante `scripts/reload_ui.sh`.

### Capa B: El Sistema Base (La Producción)
*   **Ubicación Futura**: `/usr/lib/midistroia` (Assets y scripts), `/etc/xdg/midistroia` (Configuraciones base).
*   **Binarios**: Ags permite "bundles" (`ags bundle`) que empaquetan todo el JS/TS/CSS en un único archivo para su ejecución eficiente por el usuario final.
*   **Instalación**: Se usará el motor `system_root/` para superponer los archivos sobre la raíz del sistema durante la creación de la ISO.

### Capa C: La Configuración de Usuario (Skeleton)
*   **Ubicación**: `~/.config/hypr/`, `~/.config/ags/`.
*   **Estrategia "Skel"**: Las configuraciones "maestras" guardadas en el repositorio se copian a `/etc/skel/` en la ISO, permitiendo que cada usuario nuevo empiece con la experiencia DistroIA completa y configurada.

---

## 2. Flujo de Trabajo: De Código a ISO

El proceso de empaquetado seguirá este orden lógico:

1.  **Bundle UI**: Compilar `ui/ags-v3/` mediante el comando `ags bundle` para generar el artefacto final de interfaz.
2.  **Sync Root**: Sincronizar las carpetas críticas (Hypr, Kitty, Fonts, Icons) con `system_root/`.
3.  **ISO Gen (Cubic)**: Inyectar el repositorio en una base Ubuntu 24.04 limpia, ejecutar el provisionador y generar la ISO instalable.

## 3. Estructura Actual vs Producción

| Componente | Desarrollo (`~/Dev`) | Producción (ISO) |
| :--- | :--- | :--- |
| **Interfaz (Ags)** | `ui/ags-v3/app.ts` | `/usr/share/midistroia/ui/app.js` |
| **Motor de Ventanas** | `config/hypr/hyprland.conf` | `/etc/skel/.config/hypr/hyprland.conf` |
| **Servicios DBus** | Inyectados por Ags local | `/usr/share/dbus-1/services/` |
| **Estilos CSS** | `ui/ags-v3/style.css` | Embebido en el bundle JS |

---

## 4. Estado del Empaquetado

Actualmente estamos en la **Fase de Integración Profunda**. El script de validación supervisa que la estructura de `system_root/` sea siempre fiel a la realidad del sistema para asegurar que el "build" sea predecible.

*Actualizado por Antigravity el 05/02/2026.*
