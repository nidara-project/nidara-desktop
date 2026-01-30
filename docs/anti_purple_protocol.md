# Protocolo Anti-Morado: Configuración de Transparencia Hyprland

> [!IMPORTANT]
> Este documento define la **UNICA** configuración validada que garantiza la eliminación del fondo/borde morado en el Dock transparente. Cualquier desviación reintroducirá el artefacto.

## 1. El Problema "Purple Haze"

El "fondo morado" o borde oscuro alrededor del dock es causado por el shader de desenfoque (blur) de Hyprland interactuando con píxeles de baja opacidad (sombras, bordes de ventana, o basura del tema GTK) que no son totalmente transparentes.

*   **Síntoma**: Halo morado/negro alrededor o detrás del dock.
*   **Causa**: `ignore_alpha` demasiado bajo permite que el blur procese píxeles "casi" transparentes (ej. alpha 0.01 - 0.1).

## 2. La Solución "Golden Config" (Sintaxis V2)

Para eliminar el morado, debemos ser **agresivos** con el filtrado alpha y puristas con el renderizado de color.

**Archivo**: `~/.config/hypr/hyprland.conf`

```ini
# --- REGLA DE ORO ---
layerrule = blur 1, match:namespace crystal-dock
layerrule = ignore_alpha 0.5, match:namespace crystal-dock
layerrule = xray 1, match:namespace crystal-dock
```

### Componentes Críticos

1.  **`match:namespace` (Sintaxis Estricta V2)**
    *   **Obligatorio**: Hyprland v0.53+ requiere selectores explícitos.
    *   *Prohibido*: Usar sintaxis antigua sin `match:` (ej. `blur, crystal-dock`).

2.  **`ignore_alpha 0.5` (El "Martillo")**
    *   **Función**: Ordena al compositor IGNORAR cualquier píxel con opacidad menor al 50%.
    *   **Efecto**: Elimina el morado porque la "basura" del tema suele ser sutil (< 0.2).
    *   **Trade-off**: Si el dock tiene opacidad 0.12, **también pierde el blur**. Es el precio de la transparencia perfecta sin artefactos.
    *   *Prohibido*:ajar este valor por debajo de 0.2 traerá de vuelta el morado.

3.  **`xray 1` (Pureza)**
    *   **Función**: Renderizado "paso a través". Evita que el blur se mezcle erróneamente con el fondo negro/oscuro.
    *   *Prohibido*: Eliminar esta línea.

## 3. Lista de Verificación de Mantenimiento

Si el morado vuelve tras una actualización, verificar:

- [ ] ¿Se ha roto la sintaxis en `hyprland.conf`? (Verificar con `hyprctl reload`).
- [ ] ¿Alguien bajó `ignore_alpha` a `0.1` o `0.05` intentando recuperar el blur? -> **REVERTIR A 0.5**.
- [ ] ¿Se ha desactivado `xray`? -> **REACTIVAR**.

## 4. FAQ Crítico: "¿Por qué no hay Blur?"

**Respuesta**: Porque `ignore_alpha 0.5` está haciendo su trabajo "demasiado bien".

*   Tu Dock actual (0.12) es ignorado por el filtro (0.5).
*   **Intento Fallido**: Probamos bajar el filtro a `0.15`. **Resultado**: El morado volvió.
*   **Conclusión**: La "basura" del tema es > 0.15. No se puede bajar el filtro.

### ¿Se puede arreglar?
Solo hay dos caminos:
1.  **Opción A (Actual - Segura)**: Opacidad Dock 0.12 / Ignore 0.5 -> **Sin Blur**, Sin Morado.
2.  **Opción B (Alta Opacidad)**: Subir Dock a **0.60** -> Blur vuelve, pero el dock será mucho más oscuro.

*Estado*: Revertido a Opción A por estabilidad mental.

## 5. Estado Actual (Aprobado)

*   **Fondo**: Limpio (Transparente Real).
*   **Bordes**: Nítidos (Sin Halo).
*   **Blur**: **ACTIVADO y Nítido**.

*   **Fondo**: Limpio (Transparente Real).
*   **Bordes**: Nítidos (Sin Halo).
*   **Blur**: Desactivado tácticamente (debido a `ignore_alpha 0.5`) para preservar la pureza visual.
