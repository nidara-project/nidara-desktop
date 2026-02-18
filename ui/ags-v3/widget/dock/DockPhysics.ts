/**
 * MiDistroIA - Core Dock Physics
 * Algoritmo de distorsión espacial para replicar el efecto 'Genie/Magnification' de macOS.
 */

// Constantes de calibración
export const DOCK_CONSTANTS = {
    // PHYSICS - Critical Damping Spring
    minSize: 64,        // Tamaño base
    maxSize: 96,        // Magnificación máxima
    range: 3.8,         // V145: Sweet spot for smooth but defined macOS-like wave
    sensitivity: 0.35,
    STIFFNESS: 320,     // Aceleración del muelle
    DAMPING: 34,        // Amortiguación (Críticamente amortiguado para evitar oscilación)

    // LAYOUT
    ICON_SIZE: 64,
    APP_SLOT: 82,       // 64 + 18 (9px margin each side)
    SEPARATOR_SLOT: 20, // 2px line + 9px margin each side
    SEPARATOR_LINE: 1,
    BASE_MARGIN: 9,     // 18 / 2

    // ANIMATION
    TICK_INTERVAL: 16,
    TOOLTIP_DELAY: 500,

    // WINDOW GEOMETRY
    PILL_HEIGHT: 100,
    WINDOW_HEIGHT: 200,
    EXCLUSIVE_ZONE: 110,
};

export interface DockItemMetrics {
    width: number;
    height: number;
    translateY: number;
    scale: number;
    margin: number;
}

/**
 * V621: DYNAMIC PEAK PROJECTION
 * Calcula la posición "virtual" del ratón basándose en la expansión real del Dock.
 */
export function getProjectedMouseX(qX: number, screenWidth: number, totalStaticWidth: number, totalCurrentWidth: number): number {
    const center = screenWidth / 2;
    // Normalized position relative to center (-1 to 1) 
    const relPos = (qX - center) / (totalStaticWidth / 2 || 1);

    // DYNAMIC COUNTER-SHIFT
    // As the dock expands from totalStaticWidth to totalCurrentWidth, we compensate 
    // for the center-relative movement of the static slots.
    const maxShift = (totalCurrentWidth - totalStaticWidth) / 2;

    return qX + (relPos * maxShift);
}

/**
 * Calcula las métricas para un solo item basadas en la campana de Gauss/Coseno.
 */
export function calculateDockItemMetrics(pX: number, staticCenter: number, isSeparator = false): DockItemMetrics {
    const distance = Math.abs(pX - staticCenter);
    const sigma = DOCK_CONSTANTS.APP_SLOT * DOCK_CONSTANTS.range;

    let intensity = 0;
    if (distance < sigma) {
        // V140: Cosine-based magnification curve with 1.6 power for crisper peak
        const normalizedDist = distance / sigma;
        intensity = Math.pow(Math.cos(normalizedDist * (Math.PI / 2)), 1.6);
    }

    if (isSeparator) {
        return {
            scale: 1.0,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT,
            height: 48,
            translateY: 0,
            margin: 0
        };
    }

    const targetScale = 1 + (intensity * ((DOCK_CONSTANTS.maxSize / DOCK_CONSTANTS.minSize) - 1));
    const targetWidth = DOCK_CONSTANTS.minSize * targetScale;
    const dynamicMargin = DOCK_CONSTANTS.BASE_MARGIN;

    // PURE macOS ANCHOR: No vertical lift.
    const translateY = 0;

    return {
        width: targetWidth,
        height: targetWidth,
        scale: targetScale,
        translateY: translateY,
        margin: dynamicMargin
    };
}
