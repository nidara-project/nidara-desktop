/**
 * MiDistroIA - Core Dock Physics
 * Algoritmo de distorsión espacial para replicar el efecto 'Genie/Magnification' de macOS.
 * * Corrección principal: Sincronización 1:1 entre Layout y Render.
 */

// Constantes de calibración
export const DOCK_CONSTANTS = {
    // PHYSICS
    minSize: 64,        // Tamaño base
    maxSize: 96,        // Magnificación máxima
    range: 3.2,         // V143: Balanced range for smooth entry
    sensitivity: 0.35,
    // LAYOUT
    ICON_SIZE: 64,
    BASE_MARGIN: 9,
    SEPARATOR_SLOT: 20,
    SEPARATOR_LINE: 1,
    SEPARATOR_OFFSET: 9,
    APP_SLOT: 82,
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
 * V69: Zero-Shift Perspective Correction
 * Calcula la posición "virtual" del ratón compensando la expansión del Dock centrado.
 */
export function getProjectedMouseX(qX: number, screenWidth: number, totalStaticWidth: number): number {
    if (qX < 0) return qX;

    const center = screenWidth / 2;
    // Normalize relative position (-1 to 1) 
    const relPos = (qX - center) / (totalStaticWidth / 2 || 1);

    // V612: Anchored Expansion Correction
    // This value exactly compensates for the Dock starting at (screenWidth-width)/2.
    // As it expands, the start position moves left. We shift the projected mouse
    // to "follow" the icons in their new positions.
    const maxShift = 42;

    return qX + (relPos * maxShift);
}

/**
 * Calcula las métricas para un solo item.
 */
export function calculateDockItemMetrics(qX: number, staticCenter: number, isSeparator = false): DockItemMetrics {
    if (isSeparator) {
        return {
            scale: 1.0,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT,
            height: DOCK_CONSTANTS.PILL_HEIGHT,
            translateY: 0,
            margin: 0
        };
    }

    const distance = Math.abs(qX - staticCenter);
    const sigma = DOCK_PREFS.minSize * DOCK_PREFS.range;

    let intensity = 0;
    if (distance < sigma) {
        const normalizedDist = distance / sigma;
        // Perfect Cosine Bell Curve (1.0 at center, 0.0 at sigma)
        intensity = Math.pow(Math.cos(normalizedDist * (Math.PI / 2)), 2);
    } else {
        intensity = 0; // Explicitly locked to 0 beyond range
    }

    const targetScale = 1 + (intensity * ((DOCK_PREFS.maxSize / DOCK_PREFS.minSize) - 1));
    const targetWidth = DOCK_PREFS.minSize * targetScale;
    const dynamicMargin = DOCK_CONSTANTS.BASE_MARGIN;

    return {
        width: targetWidth,
        height: targetWidth,
        scale: targetScale,
        translateY: 0,
        margin: dynamicMargin
    };
}
