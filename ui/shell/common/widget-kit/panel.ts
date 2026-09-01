import Gtk from "gi://Gtk?version=4.0"

// The PANEL vocabulary — the room a widget draws in, once the bar or the Control
// Centre has opened one for it: a width tier, and the three rows every panel was
// hand-rolling.
//
// Host-owned width vocabulary for widget panels (bar expansions + CC details).
// Part of the zero-layout widget contract: a widget picks a tier, the px scale
// belongs to the shell — it can be re-tuned globally without touching widgets,
// and a contributed widget can't invent its own panel geometry.
//
// EVERY module in common/widget-kit/ MUST stay a leaf (no shell imports): widgets
// import the kit, and CCLayoutManager imports widgets/index — importing
// CCLayoutManager from here closes a module cycle that crashes the shell at boot
// (CC_DEFAULT_ORDER undefined while CCLayoutManager's singleton evaluates
// mid-cycle). Typecheck does not catch it; only a boot does.
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

// ── Rows ──────────────────────────────────────────────────────────────────────
//
// A panel is a vertical column of these. What is NOT here, deliberately, is the
// COLUMN itself: a bar expansion sizes itself (`spacing: 12` + a PANEL_W tier) and a
// CC detail fills the panel it was given (`spacing: 0`, hexpand), and there are
// enough honest variants of each that one word for both would be a word that lies.
// Neither are the outer margins on a row: a `margin_bottom: 4` in these panels means
// "a separator follows", and a `margin_top: 4` means one precedes — context the row
// cannot know. Set them on what you get back.

/** Label on the left, a control on the right — a switch, a button, a value. The
 *  `bar-popover-key`/hexpand pairing is the whole of it, and it was written out five
 *  times (bluetooth, wifi, focus, and night light twice). */
export function panelRow(label: string, control: Gtk.Widget): Gtk.Box {
    const row = new Gtk.Box({ spacing: 8 })
    row.append(new Gtk.Label({
        label,
        css_classes: ["bar-popover-key"],
        halign: Gtk.Align.START,
        hexpand: true,
    }))
    row.append(control)
    return row
}

/** Label on the left, a live value on the right, and an `update()` that re-reads it.
 *  Was `infoRow`, duplicated BYTE FOR BYTE in wifi.ts and ethernet.ts. */
export function panelInfoRow(label: string, getValue: () => string): { row: Gtk.Box; update: () => void } {
    const key = new Gtk.Label({ label, css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const val = new Gtk.Label({ label: getValue(), css_classes: ["bar-popover-val"], halign: Gtk.Align.END })
    const row = new Gtk.Box({ spacing: 16 })
    row.append(key)
    row.append(val)
    return { row, update: () => { val.label = getValue() } }
}

/** A rule between two groups of rows, carrying its own 2px of air.
 *
 *  ⚠️ For a column with NO spacing of its own — the CC detail panels, where those 2px
 *  ARE the breathing room. Inside a `spacing: 12` bar expansion the column already
 *  provides it, and a bare `new Gtk.Separator()` is correct there (screenshot,
 *  screen recording). Those two are not drift; do not "fix" them into this. */
export function panelSeparator(): Gtk.Separator {
    return new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 2, margin_bottom: 2 })
}
