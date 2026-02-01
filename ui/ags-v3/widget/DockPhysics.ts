/**
 * MiDistroIA - Core Dock Physics
 * Algoritmo de distorsión espacial para replicar el efecto 'Genie/Magnification' de macOS.
 * * Corrección principal: Sincronización 1:1 entre Layout y Render.
 */

// Constantes de calibración
const DOCK_PREFS = {
    minSize: 64,        // Tamaño base (RESTAURADO)
    maxSize: 128,       // Tamaño máximo
    range: 2.5,         // Sigma Spread
    sensitivity: 0.35,  // Ajuste fino
};

export interface DockItemMetrics {
    width: number;
    height: number;
    translateY: number; // Crítico para mantener la base alineada si el layout engine falla
    scale: number;
    margin: number;     // El margen debe ser dinámico o eliminado en high-scale
}

/**
 * Calcula las métricas para un solo item basándose en la posición absoluta del ratón.
 * * @param mouseX - Posición X global del ratón
 * @param itemCenterX - Centro estático (Ground Truth) del item en pantalla
 * @param isSeparator - Si es un separador (lógica especial)
 */
export function calculateDockItemMetrics(qX: number, staticCenter: number, isSeparator = false): DockItemMetrics {
    // V51: Absolute stability for separators (Zero movement/scaling)
    if (isSeparator) {
        return {
            scale: 1.0,
            width: 32, // V54: Match new compressed slot
            height: 80,
            translateY: 0,
            margin: 0
        };
    }

    // 1. Distancia absoluta
    const distance = Math.abs(qX - staticCenter);

    // 2. Cálculo del Sigma dinámico
    // El 'spread' del efecto depende del tamaño base.
    const sigma = DOCK_PREFS.minSize * DOCK_PREFS.range;

    // 3. Función Gaussiana Normalizada (0.0 a 1.0)
    // Usamos una variante Sine-based para una caída más dramática que la Gaussiana pura,
    // lo que reduce el movimiento de iconos lejanos (evita jitter global).
    let intensity = 0;

    if (distance < sigma) {
        // Mapeamos la distancia a un ángulo entre 0 y PI (mitad de una onda sinusoidal)
        // Esto da una transición más suave y "orgánica" que Math.exp
        const normalizedDist = distance / sigma;
        intensity = Math.pow(Math.cos(normalizedDist * (Math.PI / 2)), 2);
    }

    // 4. Interpolación de Escala
    const targetScale = 1 + (intensity * ((DOCK_PREFS.maxSize / DOCK_PREFS.minSize) - 1));

    // 5. Cálculo de Dimensiones Físicas (Layout)
    // CRÍTICO: El width físico debe ser idéntico al visual para empujar a los vecinos.
    const targetWidth = DOCK_PREFS.minSize * targetScale;

    // 6. Cálculo de Separación (Margin)
    // V50: 8px margin + 64px icon = 80px total slot (Symmetry Fix)
    const baseMargin = 8;
    const dynamicMargin = baseMargin * (1 - (intensity * 0.5));

    return {
        width: targetWidth,
        height: targetWidth, // Asumimos aspecto 1:1
        scale: targetScale,
        translateY: 0, // En un layout Flex/Box alineado a 'end', esto debe ser 0.
        margin: dynamicMargin
    };
}
