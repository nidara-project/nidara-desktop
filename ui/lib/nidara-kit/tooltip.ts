// SPDX-License-Identifier: LGPL-3.0-or-later
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import { ARROW_H, BUF, sideFor, paintGlassBubble, type ArrowSide } from "./glass-bubble"
import { kitAppearance } from "./appearance"
import { cairoDraw } from "./platform/cairo-draw"

export type NidaraTooltipText = string | (() => string)

export interface NidaraTooltipOpts {
    /** Where the bubble sits relative to the widget (default: TOP). Just a
     *  preference: if the compositor flips/slides the popup for lack of room
     *  (tiled window at a screen edge), the Cairo arrow follows the ACTUAL
     *  placement automatically. */
    position?: Gtk.PositionType
    /** Hover dwell before it appears, ms (default: 500 — GTK's default feel). */
    delay?: number
    /** Count the dwell from when the pointer STOPS, not from when it arrives: any
     *  movement beyond a few px restarts it (default: false). For a row the pointer
     *  crosses on its way somewhere — the bar — where passing over a widget is not
     *  pointing at it. */
    restToShow?: boolean
    /** Treat the text as Pango markup instead of a plain string (default: false). */
    markup?: boolean
    /** Return true to suppress showing it (e.g. while a context menu is open). */
    suppress?: () => boolean
    /** Shell skin (glass follows the pinned appearance — legible over any wallpaper)
     *  vs app-mode (follows the system mode, e.g. the About window). Default true. */
    chrome?: boolean
}

export interface NidaraTooltipHandle {
    /** The underlying popover (rarely needed — e.g. to popdown on an external event). */
    readonly popover: Gtk.Popover
    /** Swap the text source after creation. */
    setText(text: NidaraTooltipText): void
    /** Tear down: cancel timers, hide, unparent, drop the theme subscription. */
    destroy(): void
}

// How far the pointer may drift and still count as resting (restToShow), px.
const REST_TOLERANCE = 3

// Text padding inside the body.
const PAD_X = 11     // text padding inside the body (horizontal)
const PAD_Y = 6      // text padding inside the body (vertical)

/**
 * attachTooltip — the one Nidara tooltip.
 *
 * Wires a hover-delayed glass popover to any widget, replacing GTK's default
 * system tooltip. The bubble (rounded body + pointer) is painted in Cairo as a
 * SINGLE continuous shape — one glass fill, one 1px inner-edge stroke wrapping
 * body and arrow together.
 *
 * @example
 *   attachTooltip(button, t("settings.about.close"), { chrome: false })
 *   attachTooltip(iconBox, () => currentTitle(), { position, suppress: () => menu.visible })
 */
export function attachTooltip(
    widget: Gtk.Widget,
    text: NidaraTooltipText,
    opts: NidaraTooltipOpts = {},
): NidaraTooltipHandle {
    const { position = Gtk.PositionType.TOP, delay = 500, restToShow = false, markup = false, suppress, chrome = true } = opts
    const requestedSide = sideFor(position)
    let side: ArrowSide = requestedSide
    let arrowOffset = 0

    let textSource = text

    const popover = new Gtk.Popover({
        position,
        autohide: false,            // passive label — never grab input/keyboard focus
        has_arrow: false,           // we paint our own pointer in Cairo
        css_classes: ["nidara-tooltip"],
    })

    const grid = new Gtk.Grid()
    const da = new Gtk.DrawingArea({
        hexpand: true, vexpand: true,
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
    })
    da.set_draw_func(cairoDraw((_da, cr, w, h) => {
        const dark = opts.chrome === false
            ? kitAppearance().surfaceIsDark(widget)
            : undefined
        paintGlassBubble(cr, w, h, side, { chrome, arrowOffset, dark })
    }))
    grid.attach(da, 0, 0, 1, 1)

    const label = new Gtk.Label({ css_classes: ["nidara-tooltip-label"] })
    const applyMargins = () => {
        label.margin_top    = BUF + PAD_Y + (side === "top"    ? ARROW_H : 0)
        label.margin_bottom = BUF + PAD_Y + (side === "bottom" ? ARROW_H : 0)
        label.margin_start  = BUF + PAD_X + (side === "left"   ? ARROW_H : 0)
        label.margin_end    = BUF + PAD_X + (side === "right"  ? ARROW_H : 0)
    }
    applyMargins()
    grid.attach(label, 0, 0, 1, 1)

    const syncDarkClass = () => {
        const dark = opts.chrome === false
            ? kitAppearance().surfaceIsDark(widget)
            : (kitAppearance().chromeIsDark?.() ?? kitAppearance().surfaceIsDark(widget))
        if (dark) {
            popover.remove_css_class("light")
            popover.add_css_class("dark")
        } else {
            popover.remove_css_class("dark")
            popover.add_css_class("light")
        }
    }
    syncDarkClass()

    popover.set_child(grid)
    popover.set_parent(widget)

    // ── Follow the ACTUAL popup placement ─────────────────────────────────────
    const syncPlacement = () => {
        const root = widget.get_root()
        const surface = popover.get_surface()
        if (!root || !surface || !(surface instanceof Gdk.Popup)) return
        const [ok, b] = widget.compute_bounds(root as unknown as Gtk.Widget)
        if (!ok) return
        const [nx, ny] = (root as unknown as Gtk.Native).get_surface_transform()
        const wcx = b.get_x() + nx + b.get_width() / 2
        const wcy = b.get_y() + ny + b.get_height() / 2
        const pcx = surface.get_position_x() + surface.get_width() / 2
        const pcy = surface.get_position_y() + surface.get_height() / 2
        let newSide: ArrowSide
        let newOffset: number
        if (requestedSide === "top" || requestedSide === "bottom") {
            newSide = pcy > wcy ? "top" : "bottom"
            newOffset = wcx - pcx
        } else {
            newSide = pcx > wcx ? "left" : "right"
            newOffset = wcy - pcy
        }
        if (newSide === side && Math.abs(newOffset - arrowOffset) < 0.5) return
        side = newSide
        arrowOffset = newOffset
        applyMargins()
        da.queue_draw()
    }
    let layoutSurface: Gdk.Surface | null = null
    let layoutId: number | null = null
    popover.connect("map", () => {
        const s = popover.get_surface()
        if (s) {
            layoutSurface = s
            layoutId = s.connect("layout", () => syncPlacement())
        }
        syncPlacement()
    })
    popover.connect("unmap", () => {
        if (layoutSurface && layoutId !== null) layoutSurface.disconnect(layoutId)
        layoutSurface = null; layoutId = null
    })

    // Repaint the glass and sync contrast class when appearance changes
    const unsubTheme = kitAppearance().onChange(() => {
        syncDarkClass()
        if (da.get_mapped()) da.queue_draw()
    })

    const refresh = () => {
        const value = typeof textSource === "function" ? textSource() : textSource
        if (markup) label.set_markup(value)
        else label.set_label(value)
    }

    let timer: number | null = null
    const cancelTimer = () => { if (timer !== null) { GLib.source_remove(timer); timer = null } }

    // Where the pointer was when the running dwell started (restToShow only).
    let restX = 0, restY = 0
    const motion = new Gtk.EventControllerMotion()
    motion.connect("motion", (_c: Gtk.EventControllerMotion, x: number, y: number) => {
        if (suppress?.()) return
        if (popover.visible) return
        if (timer !== null) {
            // A tolerance, not zero: a hand on a mouse or a trackpad is never
            // perfectly still, and a dwell that restarts on a 1 px tremor never ends.
            if (!restToShow || Math.hypot(x - restX, y - restY) <= REST_TOLERANCE) return
            cancelTimer()
        }
        restX = x; restY = y
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            timer = null
            // The widget can leave its window inside the delay without being
            // destroyed — a list that rebuilds its rows under the pointer. Popping up
            // a popover whose parent has no surface is not an error in GTK, it is a
            // SIGSEGV in gtk_widget_realize (Settings → Network, forgetting a
            // network, 2026-09-14). `unmap` below cancels the timer; this is the
            // same check for a source that was already dispatching.
            if (!widget.get_mapped() || !widget.get_root()) return GLib.SOURCE_REMOVE
            // Asked again at the END of the dwell, not only at its start: a menu opened
            // by a click arrives inside the delay, and the check at motion time had
            // already said yes.
            if (suppress?.()) return GLib.SOURCE_REMOVE
            refresh()
            popover.popup()
            return GLib.SOURCE_REMOVE
        })
    })
    motion.connect("leave", () => { cancelTimer(); popover.popdown() })
    widget.add_controller(motion)
    widget.connect("unmap", () => { cancelTimer(); popover.popdown() })

    let destroyed = false
    const destroy = () => {
        if (destroyed) return
        destroyed = true
        cancelTimer()
        unsubTheme()
        popover.popdown()
        popover.unparent()
    }
    widget.connect("destroy", destroy)

    return {
        popover,
        setText: (t) => { textSource = t; if (popover.visible) refresh() },
        destroy,
    }
}
