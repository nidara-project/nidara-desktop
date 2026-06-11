// Host-owned width vocabulary for widget panels (bar expansions + CC details).
// Part of the zero-layout widget contract: a widget picks a tier, the px scale
// belongs to the shell — it can be re-tuned globally without touching widgets,
// and a contributed widget can't invent its own panel geometry.
//
// MUST stay a leaf module (no shell imports): widgets import it, and
// CCLayoutManager imports widgets/index — importing CCLayoutManager from here
// closes a module cycle that crashes the shell at boot (CC_DEFAULT_ORDER
// undefined while CCLayoutManager's singleton evaluates mid-cycle).
export const PANEL_W = {
    /** single-control panels — volume/brightness slider, screenrecord options */
    sm: 200,
    /** compact status/list — vpn */
    md: 220,
    /** action panels — battery detail, screenshot */
    lg: 240,
    /** content lists — clipboard */
    xl: 280,
    /** mirrors the CC grid width (4·80 + 3·12 = CCLayoutManager.GRID_WIDTH — keep in sync) */
    full: 356,
} as const
