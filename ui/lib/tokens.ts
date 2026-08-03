/**
 * Nidara — geometry tokens as NUMBERS (single source of truth for Cairo & layout)
 *
 * Cairo painters and NidaraScrolled's corner geometry cannot read a CSS custom
 * property — a corner that clips has to be known in px — so the radius ladder
 * exists twice: here as numbers, and in `styles/_base.scss` as `--nidara-radius-*`.
 * **The two are mirrors and must move together.** `_base.scss` carries a comment
 * pointing back at this file.
 *
 * A radius ladder is MULTIPLICATIVE, not additive: it is deliberately NOT on the
 * 4px spacing scale (see `$space-*`), because what matters is the ratio between
 * rungs, not a shared divisor. Every mature system does the same (Material 3
 * ends its ladder on 28; Tailwind's has a 6). `sm` in particular is derived, not
 * chosen: a `.nidara-row` sits 5px inside a `.nidara-list` (1px border + 3px
 * padding + 1px margin), and the concentric radius for a 16px card at that inset
 * is 11 — the ladder's 10 is that value, rounded to the rung. Change the card's
 * padding and `sm` has to be re-derived, or the nested corners stop being
 * parallel.
 */

export const RADIUS = {
    /** chip, badge, segmented button */
    xs: 6,
    /** button, input, dropdown, list row */
    sm: 10,
    /** card inside a window (settings group, sidebar capsule) */
    md: 16,
    /** window chrome, and any floating popup of the shell (system menu, bar
     *  expansion panel, CC context menu) */
    lg: 24,
    /** island / overlay sitting directly on the wallpaper (all five island modes,
     *  app grid, Prism, notification cards, CC islands) — the widest surface in
     *  the shell uses this too: radius does NOT scale with the surface here. */
    xl: 32,
} as const

/**
 * A surface that runs a `NidaraScrolled` flush into its own corner must pass its
 * radius as `cornerRadius`, or the arc clips the pill (`cornerClearFor` in
 * `nidara-kit/scrolled.ts` does the maths: lg eats 11px, xl eats 15px).
 */

/**
 * Dense panel inset — how far a row's hover fill sits from the panel's **VISIBLE**
 * edge, on all four sides.
 *
 * Uniform on purpose. The three-tier container padding (`design-system.md`) puts
 * +4 on the horizontal, and that is right while the padding is a *text* inset —
 * but the moment a child's hover fill spans the container, the padding stops being
 * text inset and becomes the FILL'S MARGIN, and a halo twice as wide at the sides
 * as at the ends reads as a mistake (measured 12 / 6 before this; no menu system
 * runs 2:1 — AppKit is ~5/4, Windows 11 flyouts 4/4). The text's own breathing
 * room lives on the row (`.nidara-menu-row` is `7px 12px`).
 *
 * ⚠️ Measured from the GLASS, not from the widget rect: `SquircleContainer` paints
 * the glass `GLASS_INSET` (2px) inside its allocation, so a box aligned to the rect
 * is that much closer to the visible edge than it looks in the source. Every dense
 * panel writes `PANEL_INSET + GLASS_INSET` and says so — that discrepancy is what
 * left the system menu 2px tighter than its siblings while its comment claimed
 * parity.
 */
export const PANEL_INSET = 12

