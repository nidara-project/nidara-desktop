/**
 * Distroia - Dock Physics Engine
 * Unified animation math: constants, magnification curve, spring stepping, and integer layout.
 */

import { dockSettings } from "./state"

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
// Values derived from dockSettings. Call syncConstants() before dock recreation.
// FIXED values (gaps/paddings) stay constant. SCALED values derive from iconSize.

function deriveConstants(iconSize: number, maxSize: number, magnification: boolean, screenGap: number) {
    // ── PROPORTIONAL RATIOS (Based on user-provided table) ──
    const MARGIN = Math.round(iconSize * 0.109375)      // 3.5@32, 5.25@48, 7@64, 10.5@96
    const ICON_GAP = Math.round(iconSize * 0.09375)       // 3@32, 4.5@48, 6@64, 9@96
    const PILL_PAD = MARGIN * 2                          // 7@32, 10.5@48, 14@64, 21@96
    const INDICATOR_PAD = 4                           // Fixed 4px indicator-to-bottom gap

    // ── DERIVED ──
    const pillHeight = iconSize + PILL_PAD * 2        // Perfect vertical symmetry
    const separatorHeight = Math.round(pillHeight * 0.75) // Apple HIG: Separator spans ~75% of the total pill height

    return {
        // PHYSICS — Critical Damping Spring
        minSize: iconSize,
        maxSize: magnification ? maxSize : iconSize,
        range: 2.5,
        SIGMA: 1.1,
        sensitivity: 0.35,
        STIFFNESS: 320,
        DAMPING: 38,

        // LAYOUT
        ICON_SIZE: iconSize,
        APP_SLOT: iconSize + ICON_GAP * 2,            // Slot uses ICON_GAP, not MARGIN
        SEPARATOR_SLOT: MARGIN * 2,
        SEPARATOR_LINE: 1,
        SEPARATOR_OFFSET: MARGIN,
        SEPARATOR_HEIGHT: separatorHeight,
        BASE_MARGIN: Math.round(iconSize * 0.125),   // 4@32, 6@48, 8@64, 12@96
        ICON_MARGIN: ICON_GAP,                        // Per-icon margin (smaller than BASE_MARGIN)
        INDICATOR_GAP: INDICATOR_PAD,
        PILL_PADDING: PILL_PAD,

        // ANIMATION
        TICK_INTERVAL: 16,
        TOOLTIP_DELAY: 500,

        // Snap thresholds
        SNAP_POS: 0.3,
        SNAP_VEL: 0.5,

        // WINDOW GEOMETRY
        PILL_HEIGHT: pillHeight,
        WINDOW_HEIGHT: Math.max(200, pillHeight + maxSize + PILL_PAD),
        EXCLUSIVE_ZONE: pillHeight + screenGap,
    }
}

export let DOCK_CONSTANTS = deriveConstants(
    dockSettings.iconSize,
    dockSettings.maxIconSize,
    dockSettings.magnification,
    dockSettings.screenGap,
)

/** Re-derive constants from current dockSettings. Call before dock rebuild. */
export function syncConstants() {
    DOCK_CONSTANTS = deriveConstants(
        dockSettings.iconSize,
        dockSettings.maxIconSize,
        dockSettings.magnification,
        dockSettings.screenGap,
    )
}



// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface DockItemMetrics {
    width: number;
    height: number;
    translateY: number;
    scale: number;
    margin: number;
}

export interface SpringChannel {
    target: number;
    current: number;
    velocity: number;
}



// ─── MAGNIFICATION CURVE ─────────────────────────────────────────────────────

/**
 * Calculates target metrics for a single item based on cosine bell magnification.
 * Pure function: no side effects, no state mutation.
 */
export function calculateDockItemMetrics(
    mouseX: number,
    staticCenter: number,
    isSeparator = false
): DockItemMetrics {
    const distance = Math.abs(mouseX - staticCenter);
    const sigma = DOCK_CONSTANTS.APP_SLOT * DOCK_CONSTANTS.SIGMA;
    const intensity = Math.exp(-0.5 * Math.pow(distance / sigma, 2));

    if (isSeparator) {
        // V610: Dynamic Separators (macOS Tahoe)
        // Separators expand slightly when neighbors magnify to provide breathing room
        const targetScale = 1.0 + (intensity * 0.4); // Max 40% expansion when fully focused
        return {
            scale: targetScale,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT * targetScale,
            height: 48,
            translateY: 0,
            margin: 0,
        };
    }

    const targetScale = 1 + (intensity * ((DOCK_CONSTANTS.maxSize / DOCK_CONSTANTS.minSize) - 1));
    const targetWidth = DOCK_CONSTANTS.minSize * targetScale;

    return {
        width: targetWidth,
        height: targetWidth,
        scale: targetScale,
        translateY: 0,
        margin: DOCK_CONSTANTS.ICON_MARGIN,
    };
}

// ─── SPRING STEPPER ──────────────────────────────────────────────────────────

/**
 * Advances a single spring channel by one time step.
 * Returns true if the spring is still active (hasn't settled).
 *
 * Uses aggressive snap: if |delta| < SNAP_POS AND |velocity| < SNAP_VEL,
 * snap immediately to target. This eliminates perpetual micro-oscillation.
 */
export function springStep(ch: SpringChannel, dt: number): boolean {
    const delta = ch.target - ch.current;
    const absDelta = Math.abs(delta);
    const absVel = Math.abs(ch.velocity);

    // Aggressive snap — kill vibration
    if (absDelta < DOCK_CONSTANTS.SNAP_POS && absVel < DOCK_CONSTANTS.SNAP_VEL) {
        ch.current = ch.target;
        ch.velocity = 0;
        return false;
    }

    // Critically damped spring: F = stiffness * delta - damping * velocity
    const force = DOCK_CONSTANTS.STIFFNESS * delta - DOCK_CONSTANTS.DAMPING * ch.velocity;
    ch.velocity += force * dt;
    ch.current += ch.velocity * dt;
    return true;
}


