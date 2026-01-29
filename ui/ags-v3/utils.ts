/**
 * Parabolic Magnification Utils - Apple Signature Precision
 */

export function calculateIconSize(
    mouseX: number,      // Posicion global del raton
    itemX: number,       // Centro del icono
    itemWidth: number,   // Ancho base del item
    baseSize: number,    // Tamaño base (ej. 64)
    maxScale: number = 1.45, // Cuanto crece
    sigma: number = 220     // Radio de efecto (Ampliado para V27 - Apple Signature)
): number {
    if (mouseX < 0) return baseSize;

    const distance = Math.abs(mouseX - itemX);
    if (distance > sigma) return baseSize;

    // Curva Gaussiana Pura (Calculo de precision Apple)
    // El factor 0.45 proporciona una transicion mas organica y menos brusca
    const factor = Math.exp(-(distance * distance) / (2 * (sigma * 0.45) ** 2));
    const size = baseSize + (baseSize * (maxScale - 1) * factor);

    return size;
}

// Deprecated: getIconSize replaced by calculateIconSize
export function getIconSize(x: number, mouseRelX: number, baseSize: number, maxScale: number, sigma: number): number {
    return calculateIconSize(mouseRelX, x, 0, baseSize, maxScale, sigma);
}
