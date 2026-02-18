/**
 * MiDistroIA - Core Dock Physics
 * Algoritmo de distorsión espacial para replicar el efecto 'Genie/Magnification' de macOS.
 */

// Constantes de calibración
export const DOCK_CONSTANTS = {
    // PHYSICS
    minSize: 64,        // Tamaño base
    maxSize: 96,        // Magnificación máxima
    range: 3.8,         // V145: Sweet spot for smooth but defined macOS-like wave
    sensitivity: 0.35,
    // LAYOUT
    ICON_SIZE: 64,
    APP_SLOT: 82,       // 64 + 18 (9px margin each side)
    SEPARATOR_SLOT: 20, // 2px line + 9px margin each side
    SEPARATOR_LINE: 1,
    BASE_MARGIN: 9,     // 18 / 2
    // ANIMATION
    LERP_FACTOR: 0.12,
    TICK_INTERVAL: 16,
    TOOLTIP_DELAY: 500,
    // WINDOW GEOMETRY
    PILL_HEIGHT: 100,
    WINDOW_HEIGHT: 200,
    EXCLUSIVE_ZONE: 110,
};

const DOCK_PREFS = {
    minSize: DOCK_CONSTANTS.minSize,
    maxSize: DOCK_CONSTANTS.maxSize,
    range: DOCK_CONSTANTS.range,
    sensitivity: DOCK_CONSTANTS.sensitivity
}

export interface DockItemMetrics {
    width: number;
    height: number;
    translateY: number;
    scale: number;
    margin: number;
}

/**
 * V614: Perfect Peak Calibration
 */
export function getProjectedMouseX(qX: number, screenWidth: number, totalStaticWidth: number): number {
    const center = screenWidth / 2;
    const relPos = (qX - center) / (totalStaticWidth / 2 || 1);
    const maxShift = 46;
    return qX + (relPos * maxShift);
}

/**
 * Calcula las métricas para un solo item.
 */
export function calculateDockItemMetrics(qX: number, staticCenter: number, isSeparator = false): DockItemMetrics {
    const distance = Math.abs(qX - staticCenter);
    const sigma = DOCK_CONSTANTS.APP_SLOT * DOCK_CONSTANTS.range;

    let intensity = 0;
    if (distance < sigma) {
        const normalizedDist = distance / sigma;
        intensity = Math.pow(Math.cos(normalizedDist * (Math.PI / 2)), 1.6);
    }

    if (isSeparator) {
        return {
            scale: 1.0,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT,
            height: 48, // V620: Authentically static macOS separator
            translateY: 0, // No lift
            margin: 0
        };
    }

    const targetScale = 1 + (intensity * ((DOCK_CONSTANTS.maxSize / DOCK_CONSTANTS.minSize) - 1));
    const targetWidth = DOCK_CONSTANTS.minSize * targetScale;
    const dynamicMargin = DOCK_CONSTANTS.BASE_MARGIN;

    // V620: PURE macOS ANCHOR
    // Icons stay anchored to the bottom, no "lifting" or "floating".
    const translateY = 0;

    return {
        width: targetWidth,
        height: targetWidth,
        scale: targetScale,
        translateY: translateY,
        margin: dynamicMargin
    };
}
