# Arquitectura de Integración Profunda (Deep Integration)

Esta guía documenta la estrategia de **Integración Profunda** utilizada en MiDistroIA para gestionar modificaciones del sistema operativo (SO) de forma versionada, segura y replicable.

## 1. El Problema: "El Síndrome de la Carpeta Dev"
Tradicionalmente, los proyectos de software viven aislados en `/home/user/Dev/Proyecto`. Sin embargo, desarrollar un Sistema Operativo (o una distro personalizada) requiere modificar archivos fuera de esa carpeta:
- Configuraciones globales (`/etc/`)
- Binarios del sistema (`/usr/bin/`)
- Iconos y temas (`/usr/share/`)
- Servicios (`/lib/systemd/`)

Si editamos estos archivos manualmente en el sistema vivo, perdemos el control de versiones. Si reinstalamos, perdemos el trabajo.

## 2. La Solución: "Repository as Operating System"
Hemos implementado un patrón de **System Overlay** (superposición de sistema). El repositorio Git no es solo una carpeta de código; es un **espejo de la estructura del sistema operativo**.

### 2.1. El directorio `system_root/`
En la raíz del repositorio, existe una carpeta llamada `system_root`.
Esta carpeta **imita exactamente** la jerarquía del sistema de archivos de Linux raíz (`/`).

**Regla de Oro:**
> Si un archivo existe en `system_root/ruta/al/archivo`, durante el despliegue (provisioning/build), ese archivo sobrescribirá o creará el archivo correspondiente en `/ruta/al/archivo` del sistema real.

#### Ejemplos:
| Archivo en Repositorio (`Repo/system_root/...`) | Destino en Sistema (`/...`) | Propósito |
| :--- | :--- | :--- |
| `etc/gdm3/custom.conf` | `/etc/gdm3/custom.conf` | Configuración de Login Manager |
| `usr/share/icons/MiIcono.svg` | `/usr/share/icons/MiIcono.svg` | Asset global del sistema |
| `etc/skel/.bashrc` | `/etc/skel/.bashrc` | Configuración por defecto para nuevos usuarios |
| `lib/systemd/system/midistro.service` | `/lib/systemd/system/midistro.service` | Servicio systemd de la distro |

### 2.2. El Motor de Despliegue (`provision_system.sh`)
El script `scripts/provision_system.sh` actúa como el agente de fusión.

1.  **Detección**: Verifica si existe `system_root/` en el proyecto.
2.  **Fusión (Overlay)**: Utiliza `cp -ru` para copiar recursivamente el contenido de `system_root/` a `/`.
    *   `-r`: Recursivo.
    *   `-u`: Update (solo sobrescribe si el archivo del repo es más nuevo).
    *   Preserva permisos y estructura.
3.  **Enlace Dinámico (UI)**: Para la interfaz gráfica (Python/GTK) que vive en `ui/` y `scripts/`, crea enlaces simbólicos en `/usr/share/midistro/`.
    *   Esto permite desarrollar en caliente sin reconstruir paquetes `.deb` cada vez.

## 3. Flujo de Trabajo para Desarrolladores

### Caso A: Modificar una configuración del sistema (ej. GDM3)
1.  **NO** edites `/etc/gdm3/custom.conf` directamente en tu máquina (bueno, puedes para probar, pero no es permanente).
2.  Crea la estructura en el repo: `mkdir -p system_root/etc/gdm3/`.
3.  Copia tu config probada: `cp /etc/gdm3/custom.conf system_root/etc/gdm3/`.
4.  Commit & Push.
5.  **Resultado**: La próxima vez que se construya la ISO o se corra el provisioner, esa config será el estándar.

### Caso B: Añadir un nuevo script global
1.  Crea el script en `system_root/usr/local/bin/mi-script`.
2.  Dale permisos de ejecución (`chmod +x`).
3.  Commit & Push.

### Caso C: Integración de IA (Deep Integration)
Si queremos que el Agente de IA tenga permisos de sistema o arranque con el sistema:
1.  Definimos el servicio en `system_root/etc/systemd/system/midistro-ai.service`.
2.  El código del agente vive en `core/ai/`, enlazado dinámicamente.

## 4. Validación (`validate_project.py`)
El script de validación ahora verifica que la estructura de `system_root/` sea coherente y no contenga archivos peligrosos o corruptos antes de permitir un build.

---
**Resumen**:
MiDistroIA no se "instala"; se **fusiona** con el sistema base.
Todo cambio de estado debe reflejarse en `system_root` para ser inmortal.
