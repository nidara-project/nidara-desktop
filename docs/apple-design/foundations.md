# macOS Design Foundations (Technical Spec)

Este documento detalla los principios técnicos de los efectos visuales de Apple para su implementación en DistroIA.

## 1. Materiales y Translucidez (Vibrancy)
macOS utiliza un sistema llamado "Vibrancy" que no es solo un desenfoque (blur), sino una mezcla de capas:
- **Background Blur**: Típicamente entre 20px y 30px.
- **Saturation Boost**: Se incrementa la saturación del fondo (~1.5x) antes del desenfoque para que los colores "brillen" a través del material.
- **Exclusion Layer**: Una capa muy fina en modo "exclusion" o "plus-lighter" para mantener el contraste del texto.
- **Noise Texture**: Una textura de grano casi imperceptible para evitar el "banding" en el degradado del desenfoque.

## 2. Esquinas Continuas (Squircles)
Apple no usa `border-radius` estándar (arcos de círculo). Usa "esquinas continuas" donde la curvatura comienza mucho antes, eliminando la transición brusca entre línea recta y curva.
- **Implementación Matemática**: Superelipse con $n \approx 4$.
- **CSS Tip**: Para simularlo en GTK/CSS, se suelen usar máscaras SVG o radios muy grandes combinados con padding específico.

## 3. Sombras (Shadows)
Las sombras de macOS son multinivel:
- **Umbra**: Sombra interna muy difusa para dar profundidad.
- **Penumbra**: Sombra direccional (hacia abajo) que indica la elevación.
- **Filtro**: `backdrop-filter: blur(...)` es esencial bajo la ventana para separar los planos.
