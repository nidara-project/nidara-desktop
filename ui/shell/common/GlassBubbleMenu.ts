import Gtk from "gi://Gtk?version=4.0"
import Theme from "../core/ThemeManager"
import { safeDisconnect } from "../core/signals"
import { RADIUS, rowInsetFor } from "../../lib/tokens"
import { sideFor, paintGlassBubble, ARROW_H, BUF, type ArrowSide } from "./GlassBubble"

// Universal Cairo glass bubble menu popover. Shared by the dock context menu
// (`surfaces/dock/DockItem.tsx`), the launcher context menu (`surfaces/app-grid/AppGrid.tsx`),
// and the CC media player source picker (`widgets/media.ts`).
//
// Encapsulates the Gtk.Popover chrome reset (`.nidara-menu-popover`), the Cairo
// squircle bubble with arrow (`paintGlassBubble`), the rows container (`.nidara-menu`),
// proper margin calculation (`rowInsetFor(RADIUS.lg)` + halo + arrow offset), and
// Theme invalidation tracking.

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

export class GlassBubbleMenu {
    readonly popover: Gtk.Popover
    readonly rows: Gtk.Box
    readonly drawingArea: Gtk.DrawingArea

    private _side: ArrowSide
    private _radiusMax: number
    private _n: number
    private _themeId = 0

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
        this.drawingArea.set_draw_func((_da, cr, w, h) =>
            paintGlassBubble(cr, w, h, this._side, { radiusMax: this._radiusMax, n: this._n })
        )
        grid.attach(this.drawingArea, 0, 0, 1, 1)

        this.rows = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ["nidara-menu"],
        })
        grid.attach(this.rows, 0, 0, 1, 1)
        this.layout()

        this._themeId = Theme.connect("changed", () => {
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
        this.popover.popup()
    }

    popdown() {
        this.popover.popdown()
    }

    destroy() {
        if (this._themeId) {
            safeDisconnect(Theme, this._themeId)
            this._themeId = 0
        }
    }
}

export default GlassBubbleMenu
