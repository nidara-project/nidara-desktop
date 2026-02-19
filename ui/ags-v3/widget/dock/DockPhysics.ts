/**
 * Distroia - Dock Physics Engine
 * Unified animation math: constants, magnification curve, spring stepping, and integer layout.
 */

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

export const DOCK_CONSTANTS = {
    // PHYSICS — Critical Damping Spring
    minSize: 64,
    maxSize: 96,
    range: 2.5,           // Soft range multiplier
    SIGMA: 1.1,           // Narrower Gaussian standard deviation
    sensitivity: 0.35,
    STIFFNESS: 320,
    DAMPING: 38,

    // LAYOUT
    ICON_SIZE: 64,
    APP_SLOT: 82,         // 64 + 18 (9px margin each side)
    SEPARATOR_SLOT: 20,   // 2px line + 9px margin each side
    SEPARATOR_LINE: 1,
    SEPARATOR_OFFSET: 9,
    BASE_MARGIN: 9,       // 18 / 2

    // ANIMATION
    TICK_INTERVAL: 16,
    TOOLTIP_DELAY: 500,

    // Snap thresholds — aggressive to kill vibration
    SNAP_POS: 0.3,        // px — snap if closer than this
    SNAP_VEL: 0.5,        // px/s — snap if velocity below this

    // WINDOW GEOMETRY
    PILL_HEIGHT: 100,
    WINDOW_HEIGHT: 200,
    EXCLUSIVE_ZONE: 110,
};

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

/** Layout slot computed with integer-only arithmetic */
export interface SlotLayout {
    slotStart: number;    // integer px
    slotWidth: number;    // integer px
    iconStart: number;    // integer px
    iconWidth: number;    // integer px
    marginStart: number;  // integer px
    marginEnd: number;    // integer px
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
        return {
            scale: 1.0,
            width: DOCK_CONSTANTS.SEPARATOR_SLOT,
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
        margin: DOCK_CONSTANTS.BASE_MARGIN,
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

// ─── INTEGER LAYOUT CALCULATOR ───────────────────────────────────────────────

/**
 * Computes pixel-perfect integer layout for all dock items.
 *
 * Uses CONSTRAINED ROUNDING (largest-remainder method) to ensure:
 * 1. Total width is maximally stable (only changes at .5 crossings)
 * 2. Individual slot changes are coordinated (no uncoordinated ±1px jumps)
 * 3. Icon and slot widths always sum to exactly the integer total
 *
 * This is the same algorithm used in proportional representation elections
 * and display pixel distribution.
 */
export function calculateLayout(
    items: Array<{ currentWidth: number; currentMargin: number; isSeparator: boolean }>,
    screenWidth: number
): { slots: SlotLayout[]; totalWidth: number; marginStart: number; floatTotalWidth: number; floatMarginStart: number } {
    const n = items.length;
    if (n === 0) return { slots: [], totalWidth: 0, marginStart: Math.round(screenWidth / 2), floatTotalWidth: 0, floatMarginStart: screenWidth / 2 };

    // Pass 1: compute float values for each slot
    const floatSlotWidths: number[] = [];
    const floatIconWidths: number[] = [];
    const floatMargins: number[] = [];
    let totalFloat = 0;

    for (const item of items) {
        const slotW = item.currentWidth + (item.currentMargin * 2);
        floatSlotWidths.push(slotW);
        floatIconWidths.push(item.currentWidth);
        floatMargins.push(item.currentMargin);
        totalFloat += slotW;
    }

    // Authoritative integer total — only changes at .5 boundary crossings
    const totalWidth = Math.round(totalFloat);
    const centerOffset = (screenWidth - totalFloat) / 2;
    const marginStart = Math.round(centerOffset);

    // Pass 2: Constrained rounding for SLOT widths
    // Floor all, then distribute leftover pixels to largest remainders
    const intSlotWidths = floatSlotWidths.map(w => Math.floor(w));
    let sumFloored = intSlotWidths.reduce((a, b) => a + b, 0);
    let deficit = totalWidth - sumFloored;

    if (deficit > 0) {
        // Build remainder index, sort by descending fractional part
        const remainders = floatSlotWidths
            .map((w, i) => ({ idx: i, frac: w - Math.floor(w) }))
            .sort((a, b) => b.frac - a.frac);
        for (let i = 0; i < deficit && i < n; i++) {
            intSlotWidths[remainders[i].idx]++;
        }
    } else if (deficit < 0) {
        // Rare: rounding pushed total above, remove from smallest remainders
        const remainders = floatSlotWidths
            .map((w, i) => ({ idx: i, frac: w - Math.floor(w) }))
            .sort((a, b) => a.frac - b.frac);
        for (let i = 0; i < -deficit && i < n; i++) {
            intSlotWidths[remainders[i].idx]--;
        }
    }

    // Pass 3: Constrained rounding for ICON widths within each slot
    // Icon width must be <= slot width - reasonable margins
    const intIconWidths = floatIconWidths.map((w, i) => {
        const iconW = Math.round(w);
        // Clamp to slot width (icon can't be wider than its slot)
        return Math.min(iconW, intSlotWidths[i]);
    });

    // Pass 4: Build slot descriptors with positions
    const slots: SlotLayout[] = [];
    let runningX = 0;

    for (let i = 0; i < n; i++) {
        const slotWidth = intSlotWidths[i];
        const iconWidth = intIconWidths[i];
        const marginLeft = Math.round(floatMargins[i]);
        const marginRight = slotWidth - iconWidth - marginLeft;

        slots.push({
            slotStart: runningX,
            slotWidth,
            iconStart: runningX + marginLeft,
            iconWidth,
            marginStart: marginLeft,
            marginEnd: Math.max(0, marginRight),
        });

        runningX += slotWidth;
    }

    return { slots, totalWidth, marginStart, floatTotalWidth: totalFloat, floatMarginStart: centerOffset };
}
