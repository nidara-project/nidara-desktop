# Estrategia de Continuidad Absoluta (Zero-Reset)

Este documento define la arquitectura para asegurar que el proyecto **MiDistroIA** mantenga su identidad, contexto y perfección técnica, incluso tras reinstalaciones totales del sistema o cambios de instancia del agente Antigravity.

## El Problema del "Borrón y Cuenta Nueva"
Los agentes de IA pueden perder el contexto si:
1. Se reinstala Antigravity (se borra la carpeta brain).
2. Se cometen errores de Git (force-push) que ocultan la historia.
3. Se toman decisiones técnicas (Wayland vs X.org) sin consultar el pasado.

## La Solución: El Anclaje de ADN
Propongo implementar los siguientes tres pilares de continuidad:

### 1. El Archivo "Project DNA" (Semilla)
Crearemos un archivo `PROJECT_DNA.md` en la raíz del repositorio. No es documentación para humanos, es el **comando de inicio** para cualquier agente nuevo.
- **Invariantes Técnicos**: Define que el proyecto es X.org, Python 4.0, Dock Orgánico con Dots.
- **Punto de Oro**: Referencia al commit hash que se validó como "Perfecto" (`fa6eacd`).
- **Comandamientos del Agente**: Reglas de NO-SABOTAJE (Ej: "Nunca hagas un Clean Push").

### 2. Duplicidad de Artefactos Críticos
Los artefactos importantes (`task.md`, `walkthrough.md`) se guardarán automáticamente en una carpeta `.antigravity/` dentro del repositorio Git.
- Esto asegura que aunque se borre la carpeta `brain`, al hacer `git clone`, el agente lea el progreso exacto.

### 3. Workflow de Recuperación Total
Si reinstalas todo de cero, solo tendrás que decir: "Lee el ADN del proyecto y sincroniza". El agente:
1. Leerá `PROJECT_DNA.md`.
2. Verificará que el historial de Git coincide con el "Punto de Oro".
3. Si hay discrepancias, priorizará el backup local sobre GitHub.

---
> [!IMPORTANT]
> Esta estrategia convierte el repositorio en una fuente de verdad inmutable para la IA, no solo en un almacén de código.
