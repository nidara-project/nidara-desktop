/**
 * Nidara - Dock Physics Engine
 * Unified animation math: constants, magnification curve, spring stepping, and integer layout.
 */

import { dockSettings } from "./state"

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
// Values derived from dockSettings. Call syncConstants() before dock recreation.
// FIXED values (gaps/paddings) stay constant. SCALED values derive from iconSize.

function deriveConstants(iconSize: number, maxSize: number, magnification: boolean, screenGap: number) {
    // All geometry must be integer: a fractional input (e.g. a slider that stored 8.19)
    // flows into EXCLUSIVE_ZONE and gets truncated by Cairo's int rectangles downstream,
    // which silently dropped the dock's outermost interactive pixel at the screen wall.
    iconSize  = Math.round(iconSize)
    maxSize   = Math.round(maxSize)
    screenGap = Math.round(screenGap)
    // ── PROPORTIONAL RATIOS (Based on user-provided table) ──
    // V24000: SLIGHT GAP BOOST
    // External padding (22%) balanced with slightly wider gap (16%).
    const PAD_RATIO = 0.22                               // ~10.5px for 48px
    const GAP_RATIO = 0.16                               // ~7.7px for 48px
    
    const PILL_PAD = Math.round(iconSize * PAD_RATIO)    // Top/Bottom air
    const GAP_TOTAL = Math.round(iconSize * GAP_RATIO)   // Total gap between icons
    const IM = GAP_TOTAL / 2                             // Margin each side
    const BASE_MARGIN = PILL_PAD - IM                    // Result: Side Air == PILL_PAD
    
    const INDICATOR_PAD = 4                              

    // ── DERIVED ──
    const pillHeight = Math.round(iconSize + PILL_PAD * 2) 
    const separatorHeight = Math.round(pillHeight * 0.75) 

    return {
        // ... (physics constants stay same)
        minSize: iconSize,
        maxSize: magnification ? maxSize : iconSize,
        SIGMA: 1.1,
        STIFFNESS: 320,
        DAMPING: 38,

        // LAYOUT
        ICON_SIZE: iconSize,
        APP_SLOT: iconSize + GAP_TOTAL,
        SEPARATOR_SLOT: Math.round(GAP_TOTAL * 2),
        SEPARATOR_LINE: 1,
        SEPARATOR_OFFSET: GAP_TOTAL,
        SEPARATOR_HEIGHT: separatorHeight,
        BASE_MARGIN: BASE_MARGIN,
        ICON_MARGIN: IM,                                 // Balanced gap
        INDICATOR_GAP: INDICATOR_PAD,
        PILL_PADDING: PILL_PAD,

        // Snap thresholds
        SNAP_POS: 0.3,
        SNAP_VEL: 0.5,

        // WINDOW GEOMETRY
        PILL_HEIGHT: pillHeight,
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
        // Separators only expand when magnification is active — they must respect the same flag
        // as regular icons. If maxSize === minSize the user disabled magnification, and the
        // separator expanding would still push the icons after it (trash/right-edge items).
        if (DOCK_CONSTANTS.maxSize > DOCK_CONSTANTS.minSize) {
            const targetScale = 1.0 + (intensity * 0.4);
            return {
                scale: targetScale,
                width: DOCK_CONSTANTS.SEPARATOR_SLOT * targetScale,
                // Height is NOT animated: neither axis applies currentHeight to the
                // separator line (H uses the SEPARATOR_HEIGHT constant, V ignores it),
                // so returning the rest height keeps the height spring settled instead
                // of pointlessly animating a value nobody renders.
                height: DOCK_CONSTANTS.SEPARATOR_HEIGHT,
                translateY: 0,
                margin: 0,
            };
        }
        return { scale: 1.0, width: DOCK_CONSTANTS.SEPARATOR_SLOT, height: DOCK_CONSTANTS.SEPARATOR_HEIGHT, translateY: 0, margin: 0 };
    }

    const targetScale = 1 + (intensity * ((DOCK_CONSTANTS.maxSize / DOCK_CONSTANTS.minSize) - 1));
    const targetWidth = DOCK_CONSTANTS.minSize * targetScale;

    return {
        width: targetWidth,
        // Same as the separator: icon layout never reads currentHeight (both axes size
        // the item from width/scale/margins), so keep the height channel at rest.
        height: DOCK_CONSTANTS.PILL_HEIGHT,
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
// ── Integration ──────────────────────────────────────────────────────────
// Semi-implicit Euler: v += (k·Δ − c·v)·h; x += v·h. The velocity update
// multiplies v by (1 − c·h) each step — when c·h > 2 the damping term itself
// flips v's sign and GROWS it every frame, so the spring diverges exponentially
// instead of settling (seen live 2026-07-18: a fullscreen window starves the
// dock's frame clock down to GDK's ~60 Hz fallback, dt clamps to MAX_DT = 1/25,
// and the auto-hide slide with c = 52 hits c·h = 2.08 → slideCurrent reached
// 1e+68 px and the exclusive zone stormed until the NaN snap reset it).
// Stability is a property of the SUBSTEP, not of the simulated time: integrate
// any dt in substeps of at most H_STABLE. H_STABLE = 1/60 keeps every damping
// used here far inside the bound (c·h ≤ 53/60 ≈ 0.88) and makes the canonical
// 144 Hz path (dt = 1/60 exactly) a single substep — bit-identical to the
// approved feel.
const H_STABLE = 1 / 60

export function stepSpring(ch: SpringChannel, dt: number, stiffness: number, damping: number): void {
    let rem = dt
    while (rem > 1e-9) {
        const h = rem > H_STABLE ? H_STABLE : rem
        ch.velocity += (stiffness * (ch.target - ch.current) - damping * ch.velocity) * h
        ch.current  += ch.velocity * h
        rem -= h
    }
}

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

    stepSpring(ch, dt, DOCK_CONSTANTS.STIFFNESS, DOCK_CONSTANTS.DAMPING)
    return true;
}

/**
 * Faster spring for reorder slide animation — critically damped so it settles
 * quickly (~250 ms) without overshoot.
 */
export function slideSpringStep(ch: SpringChannel, dt: number): boolean {
    const STIFFNESS = 700
    const DAMPING   = 53   // ≈ 2√700 → critically damped

    const delta  = ch.target - ch.current
    if (Math.abs(delta) < 0.5 && Math.abs(ch.velocity) < 1.0) {
        ch.current = ch.target
        ch.velocity = 0
        return false
    }
    stepSpring(ch, dt, STIFFNESS, DAMPING)
    return true
}


