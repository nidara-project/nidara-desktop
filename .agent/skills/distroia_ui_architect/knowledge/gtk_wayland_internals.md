GTK & Hyprland: Advanced Rendering & Node Internals

Este documento detalla el comportamiento interno de los nodos de renderizado de GTK para solucionar artefactos visuales en DistroIA.

1. El Problema de la "Contaminación de Color" en Hover (Icon Color Bleed)

Síntoma: Los botones (especialmente en Docks) cambian su color de fondo sutilmente basándose en el color predominante del icono que contienen.
Causa Técnica:
GTK trata los botones como contenedores semánticos. Si no se define un background-color absoluto y opaco para el estado :hover, GTK4 y versiones modernas de GTK3 utilizan mecanismos de tinta (ink reaction).

El nodo interno decoration o ripple extrae el color del primer plano (el icono) y lo aplica con opacidad al fondo para crear un efecto de "brillo" coherente.

Solución Técnica (CSS Reset Profundo):
No basta con cambiar el background-color del botón. Debes matar los nodos internos que generan el efecto.

/* Elimina el efecto ripple/tinta */
button * {
    -gtk-icon-effect: none; 
    text-shadow: none;
    -gtk-icon-shadow: none;

}

/* Nodos internos críticos en GTK3/4 */
button ripple {
    background-image: none;
    background-color: transparent;
    box-shadow: none;
    opacity: 0;
}

/* Evita que el foco cambie colores */
button:focus, button:active, button:checked {
    box-shadow: none;
    outline: none;
    background-image: none; /* Importante: GTK usa patterns aquí a veces */
}


2. El "Parpadeo Fantasma" (The Ghost Flicker)

Síntoma: Un parpadeo negro o blanco detrás de los widgets, o sobre el fondo con blur, que ocurre aleatoriamente o al mover el mouse, no solo al inicio.
Causas y Soluciones:

A. Overshoot/Undershoot (Sombras de Scroll)

GTK dibuja sombras gradientes automáticas cuando una lista (ScrolledWindow) llega al final o principio. Incluso si no estás haciendo scroll, un cambio de tamaño de milisegundos puede dispararlas.
Fix:

overshoot, undershoot {
    background-image: none;
    background-color: transparent;
    box-shadow: none;
    border: none;
    min-height: 0; /* Colapsar el nodo */
}


B. Viewport Background vs Window Background

En GTK, un GtkScrolledWindow contiene un GtkViewport. Si el viewport no es transparente, puede renderizar un cuadro opaco por un frame antes de que el compositor aplique el shader de blur.
Fix:

scrolledwindow, viewport, list {
    background-color: transparent;
    border: none;
}


C. The Highlight Node (Solo GTK3/GJS)

Algunos widgets tienen un nodo interno llamado highlight que se activa en hover/focus para dibujar un borde brillante.
Fix:

highlight {
    background-color: transparent;
    background-image: none;
    border-width: 0;
}


3. Depuración Real (Inspection)

Para que el Agente pueda ver lo que ocurre, debe instruir al usuario para usar el Inspector Interactivo. Es la única forma de ver los nodos "invisibles" (como ripple o overshoot).

Comando: GTK_DEBUG=interactive ./tu-script-ags

Acción: Ir a la pestaña "CSS Nodes".

Objetivo: Buscar nodos hijos del widget problemático que no corresponden a widgets creados por el usuario (ej. gadget, decoration, cursors).

4. Layer Shell & Hyprland Quirks

Exclusive Zone Flicker

Si cambias dinámicamente el tamaño de un widget anclado (ej. un dock que crece al hacer hover), exclusive_zone forzará a Hyprland a reorganizar TODAS las ventanas del escritorio. Esto causa un parpadeo masivo en todo el sistema.

Regla: Para docks animados, usa exclusive_zone = -1 (o fijo) y maneja el espacio visualmente, o usa márgenes fijos.

Input Regions (Clics Bloqueados)

Si el dock tiene sombras grandes o glow effects, esos píxeles "transparentes" pueden bloquear clics en la ventana de abajo si la input-region no se recorta.

Diagnóstico: El usuario no puede hacer clic en ventanas debajo de la sombra del dock.

Solución en Astal/AGS: Configurar inputRegion para que coincida exactamente con la forma visible del dock, excluyendo las sombras decorativas.
