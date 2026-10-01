// SPDX-License-Identifier: LGPL-3.0-or-later
import Gtk from "gi://Gtk?version=4.0"
import { RADIUS, rowInsetFor } from "./platform/tokens"
import { kitAppearance } from "./appearance"
import { sideFor, paintGlassBubble, trackBubbleGlass, ARROW_H, BUF, type ArrowSide } from "./glass-bubble"
import { cairoDraw } from "./platform/cairo-draw"

// Universal Cairo glass bubble menu popover. Shared by dock context menu,
// launcher context menu, media widget, and any Nidara surface or app needing
// a glass popover menu.
//
// Encapsulates Gtk.Popover styling (.nidara-menu-popover), Cairo squircle
// bubble with arrow (paintGlassBubble), rows container (.nidara-menu),
// proper margin calculation (rowInsetFor(RADIUS.lg) + halo + arrow offset),
// and kit appearance invalidation tracking.

export interface GlassBubbleMenuOpts {
    /** The widget the popover anchors to. */
    parent: Gtk.Widget
    /** The relative position of the popover (default: BOTTOM). */
    position?: Gtk.PositionType
    /** Direct arrow side override if not derived from position. */
    side?: ArrowSide
    /** Corner radius cap (default: RADIUS.lg). */
    radiusMax?: number
    /** Squircle exponent (default: 3.2). */
    n?: number
    /** Custom CSS class on the popover (default: ["nidara-menu-popover"]). */
    cssClasses?: string[]
}

/** False when some ancestor of `w` (or `w` itself) refuses focus — GTK4's
 *  `can-focus` is "may the focus enter this widget or any of its children". */
function focusCanEnter(w: Gtk.Widget | null): boolean {
    for (; w; w = w.get_parent()) if (!w.can_focus) return false
    return true
}

export class GlassBubbleMenu {
    readonly popover: Gtk.Popover
    readonly rows: Gtk.Box
    readonly drawingArea: Gtk.DrawingArea

    private _side: ArrowSide
    private _radiusMax: number
    private _n: number
    private _unsubTheme: (() => void) | null = null

    constructor(opts: GlassBubbleMenuOpts) {
        const pos = opts.position ?? Gtk.PositionType.BOTTOM
        this._side = opts.side ?? sideFor(pos)
        this._radiusMax = opts.radiusMax ?? RADIUS.lg
        this._n = opts.n ?? 3.2

        this.popover = new Gtk.Popover({
            autohide: true,
            has_arrow: false,
            css_classes: opts.cssClasses ?? ["nidara-menu-popover"],
        })
        this.popover.position = pos
        this.popover.set_has_tooltip(false)

        const grid = new Gtk.Grid()
        this.drawingArea = new Gtk.DrawingArea({
            hexpand: true, vexpand: true,
            halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        })
        this.drawingArea.set_draw_func(cairoDraw((_da, cr, w, h) =>
            paintGlassBubble(cr, w, h, this._side, { radiusMax: this._radiusMax, n: this._n, widget: this.popover })
        ))
        grid.attach(this.drawingArea, 0, 0, 1, 1)
        trackBubbleGlass(this.drawingArea, () => this._side, () => this._radiusMax, () => this._n)

        this.rows = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ["nidara-menu"],
        })
        grid.attach(this.rows, 0, 0, 1, 1)
        this.layout()

        this._unsubTheme = kitAppearance().onChange(() => {
            if (this.drawingArea.get_mapped()) this.drawingArea.queue_draw()
        })
        this.popover.connect("destroy", () => this.destroy())

        this.popover.set_child(grid)
        this.popover.set_parent(opts.parent)
    }

    get side(): ArrowSide {
        return this._side
    }

    setSide(side: ArrowSide) {
        if (this._side === side) return
        this._side = side
        this.layout()
        this.drawingArea.queue_draw()
    }

    setPosition(pos: Gtk.PositionType) {
        this.popover.position = pos
        this.setSide(sideFor(pos))
    }

    layout() {
        const PAD = rowInsetFor(this._radiusMax)
        this.rows.margin_top    = BUF + PAD + (this._side === "top"    ? ARROW_H : 0)
        this.rows.margin_bottom = BUF + PAD + (this._side === "bottom" ? ARROW_H : 0)
        this.rows.margin_start  = BUF + PAD + (this._side === "left"   ? ARROW_H : 0)
        this.rows.margin_end    = BUF + PAD + (this._side === "right"  ? ARROW_H : 0)
    }

    clearRows() {
        let c = this.rows.get_first_child()
        while (c) {
            const next = c.get_next_sibling()
            this.rows.remove(c)
            c = next
        }
    }

    popup() {
        // GTK 4.22 (and main, checked 2026-09-27): an autohide popover moves focus into
        // itself on show, and when no child can take it, `gtk_popover_focus` hands the
        // root's focus — NULL — to `gtk_widget_is_ancestor` unchecked: a Gtk-CRITICAL on
        // every open. No child can take it whenever an ANCESTOR of the popover has
        // `can_focus: false` — the dock's icons did, until the dock became keyboard-walkable
        // (Super+Ctrl+D, 2026-09-27); the guard stays for any other such tree. In that case focus could not
        // enter anyway, so the popover is told not to try; where it can, nothing changes
        // (measured in a headless cage: blocked → 3 CRITICALs in 3 opens, now 0; allowed
        // → focus still lands on the first row).
        this.popover.can_focus = focusCanEnter(this.popover.get_parent())
        this.popover.popup()
    }

    popdown() {
        this.popover.popdown()
    }

    destroy() {
        if (this._unsubTheme) {
            this._unsubTheme()
            this._unsubTheme = null
        }
    }
}

export { GlassBubbleMenu as NidaraMenu }
export default GlassBubbleMenu
