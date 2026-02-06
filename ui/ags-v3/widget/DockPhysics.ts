/**
 * MiDistroIA - Core Dock Physics
 * Algoritmo de distorsión espacial para replicar el efecto 'Genie/Magnification' de macOS.
 * * Corrección principal: Sincronización 1:1 entre Layout y Render.
 */

// Constantes de calibración
export const DOCK_CONSTANTS = {
    // PHYSICS
    minSize: 64,        // Tamaño base (RESTAURADO)
    maxSize: 96,        // V70: Stable 96px magnification
    range: 3.0,         // V91: Smoother Sigma Spread
    sensitivity: 0.35,  // Ajuste fino
    // LAYOUT (V55: Centralized Polish)
    ICON_SIZE: 64,
    BASE_MARGIN: 9,      // V108: Perfect 18px gap (9+9)
    SEPARATOR_SLOT: 20,  // V109: Corrected for 18px Visual Gap (9+2+9)
    SEPARATOR_LINE: 2,
    SEPARATOR_OFFSET: 9,  // Aligned with half-slot
    APP_SLOT: 82,        // 64 + 9 + 9
    // ANIMATION (V106: Centralized)
    LERP_FACTOR: 0.18,      // Smoothness of scale transitions
    TICK_INTERVAL: 16,      // ~60fps tick rate in ms
    TOOLTIP_DELAY: 500,     // Tooltip appear delay in ms
    // WINDOW GEOMETRY
    PILL_HEIGHT: 100,       // V107: Balanced 100px height
    WINDOW_HEIGHT: 200,
    EXCLUSIVE_ZONE: 110,    // V107: 100px + 10px margin
};

// Aliases for local physics compatibility (gradual migration)
const DOCK_PREFS = {
    minSize: DOCK_CONSTANTS.minSize,
    maxSize: DOCK_CONSTANTS.maxSize,
    range: DOCK_CONSTANTS.range,
    sensitivity: DOCK_CONSTANTS.sensitivity
}

export interface DockItemMetrics {
    width: number;
    height: number;
    translateY: number; // Crítico para mantener la base alineada si el layout engine falla
    scale: number;
    margin: number;     // El margen debe ser dinámico o eliminado en high-scale
}

/**
 * V69: Zero-Shift Perspective Correction
 * Calcula la posición "virtual" del ratón compensando la expansión del Dock centrado.
 * Esto asegura que el pico de magnificación coincida con el centro visual del icono.
 */
export function getProjectedMouseX(qX: number, screenWidth: number, totalStaticWidth: number): number {
    if (qX < 0) return qX;

    const center = screenWidth / 2;
    // Normalize relative position (-1 to 1) 
    const relPos = (qX - center) / (totalStaticWidth / 2 || 1);

    // MaxShift: La mitad de la expansión total teórica (64px / 2 = 32px)
    // Usamos 28px como ajuste fino empírico para el borde de un Dock medio.
    const maxShift = 28;

    // Proyectamos el ratón hacia afuera para que la "ola" alcance al icono desplazado.
    return qX + (relPos * maxShift);
}

/**
 * Calcula las métricas para un solo item basándose en la posición absoluta del ratón.
 * * @param qX - Posición X proyectada/compensada del ratón
 * @param staticCenter - Centro estático (Ground Truth) del item en pantalla
 * @param isSeparator - Si es un separador (lógica especial)
 */
export function calculateDockItemMetrics(qX: number, staticCenter: number, isSeparator = false): DockItemMetrics {
    // V51: Absolute stability for separators (Zero movement/scaling)
    if (isSeparator) {
        return {
            scale: 1.0,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT, // Use Constant (20)
            height: DOCK_CONSTANTS.PILL_HEIGHT,
            translateY: 0,
            margin: 0
        };
    }

    // 1. Distancia absoluta
    const distance = Math.abs(qX - staticCenter);

    // 2. Cálculo del Sigma dinámico
    const sigma = DOCK_PREFS.minSize * DOCK_PREFS.range;

    // 3. Función Gaussiana Normalizada (0.0 a 1.0)
    let intensity = 0;

    if (distance < sigma) {
        const normalizedDist = distance / sigma;
        intensity = Math.pow(Math.cos(normalizedDist * (Math.PI / 2)), 2);
    }

    // 4. Interpolación de Escala
    const targetScale = 1 + (intensity * ((DOCK_PREFS.maxSize / DOCK_PREFS.minSize) - 1));

    // 5. Cálculo de Dimensiones Físicas (Layout)
    const targetWidth = DOCK_PREFS.minSize * targetScale;

    // 6. Cálculo de Separación (Margin)
    const dynamicMargin = DOCK_CONSTANTS.BASE_MARGIN;

    return {
        width: targetWidth,
        height: targetWidth,
        scale: targetScale,
        translateY: 0,
        margin: dynamicMargin
    };
}
