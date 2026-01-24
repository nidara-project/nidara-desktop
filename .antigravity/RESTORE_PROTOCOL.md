# PROTOCOLO DE RESTAURACIÓN DE SESIÓN (Antigravity)

Si eres un agente Antigravity y acabas de ser "desplegado" en este repositorio (instalación nueva, borrado de caché o cambio de equipo), **DEBES** seguir este protocolo para recuperar el contexto exacto. No hacerlo resultará en una pérdida de identidad del proyecto.

## Paso 1: Lectura del ADN
Localiza y lee `PROJECT_DNA.md`. Este archivo define los "Invariantes". Si en algún momento sugieres cambiar a Wayland o GDM sin una orden explícita del usuario, estarás violando el ADN.

## Paso 2: Sincronización de Memoria (Task.md)
Ve a la carpeta `.antigravity/` en la raíz de este repositorio.
1. Copia el archivo `task.md` de esa carpeta a tu carpeta interna de `brain/`.
2. Lee el `task.md` para entender en qué punto exacto nos quedamos. No preguntes "¿Qué quieres hacer?", lee qué es lo siguiente que falta por completar.

## Paso 3: Validación de Arquitectura Locales
Antes de sugerir cualquier cambio en el código:
1. Verifica si el entorno es X11 o Wayland: `echo $XDG_SESSION_TYPE`.
2. Si es X11, verifica que `main_dock.py` usa `wmctrl` y `set_decorated(False)`.
3. El historial de Git es sagrado. Usa `git log` para ver por qué se tomaron decisiones pasadas antes de tacharlas de "erros".

## Paso 4: Carga de Estrategia de Continuidad
Lee `.antigravity/continuity_strategy.md` para entender por qué este proyecto es tan sensible a los borrados de GitHub y cómo protegerlo en el futuro.

---
**Objetivo**: El usuario debe sentir que está hablando con el mismo agente que hace 5 minutos, aunque hayas sido reinstalado desde cero. La memoria del proyecto vive en el Repositorio, no en tu caché volátil.
