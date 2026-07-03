import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"
import { ARROW_H, BUF, sideFor, paintGlassBubble, type ArrowSide } from "./GlassBubble"

export type NidaraTooltipText = string | (() => string)

export interface NidaraTooltipOpts {
    /** Where the bubble sits relative to the widget (default: TOP). Just a
     *  preference: if the compositor flips/slides the popup for lack of room
     *  (tiled window at a screen edge), the Cairo arrow follows the ACTUAL
     *  placement automatically. */
    position?: Gtk.PositionType
    /** Hover dwell before it appears, ms (default: 500 — GTK's default feel). */
    delay?: number
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

// Text padding inside the body. The glass bubble silhouette + pointer + the 0.38
// popup-blur floor all live in the shared `common/GlassBubble.ts` (the dock context
// menu paints the same bubble). Only the label's interior padding is tooltip-specific.
const PAD_X = 11     // text padding inside the body (horizontal)
const PAD_Y = 6      // text padding inside the body (vertical)

/**
 * attachTooltip — the one Nidara tooltip.
 *
 * Wires a hover-delayed glass popover to any widget, replacing GTK's default
 * system tooltip. The bubble (rounded body + pointer) is painted in Cairo as a
 * SINGLE continuous shape — one glass fill, one 1px inner-edge stroke wrapping
 * body and arrow together. A GTK popover arrow can't do this on translucent
 * glass: GTK always strokes the arrow's base where it meets the body, and that
 * seam shows through the translucency. The popover is still its own surface, so
 * it picks up Hyprland's compositor blur on the bar/dock → real glass.
 *
 * Lives in `common/` (not `lib/nidara-kit`) because it reads `Theme` — same as
 * the other shared Cairo widgets (SquircleContainer, Slider, ScaleRevealer).
 *
 * Text may be a string or a getter. A getter is resolved lazily, the instant
 * before the tooltip shows, so live values (a window title) stay fresh WITHOUT
 * subscribing to them (a subscription would force a dock redraw + blur pass per
 * title tick; see DockItem.computeTitle).
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
    const { position = Gtk.PositionType.TOP, delay = 500, markup = false, suppress, chrome = true } = opts
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
    da.set_draw_func((_da, cr, w, h) => paintGlassBubble(cr, w, h, side, { chrome, arrowOffset }))
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

    popover.set_child(grid)
    popover.set_parent(widget)

    // ── Follow the ACTUAL popup placement ─────────────────────────────────────
    // On Wayland the compositor, not GTK, has the final say on where a popup
    // lands (xdg_positioner): it FLIPS to the opposite side when the requested
    // one has no room (a tiled window's close button at the screen's top edge)
    // and SLIDES along the edge when the bubble would overflow the monitor. A
    // native popover repositions its arrow after that; our arrow is Cairo, so we
    // must do it ourselves: read where the popup surface actually went (GdkPopup
    // position is parent-surface-relative), then repaint the arrow on the side
    // facing the widget with the base shifted to keep aiming at it. Swapping the
    // two ARROW_H margins keeps the popover size identical, so the correction
    // never re-triggers positioning (no feedback loop).
    const syncPlacement = () => {
        const root = widget.get_root()
        const surface = popover.get_surface()
        if (!root || !surface || !(surface instanceof Gdk.Popup)) return
        const [ok, b] = widget.compute_bounds(root as unknown as Gtk.Widget)
        if (!ok) return
        // Widget centre in parent-surface coordinates (root widget coords + the
        // root's surface transform, i.e. its client-side shadow inset).
        const [nx, ny] = (root as unknown as Gtk.Native).get_surface_transform()
        const wcx = b.get_x() + nx + b.get_width() / 2
        const wcy = b.get_y() + ny + b.get_height() / 2
        const pcx = surface.get_position_x() + surface.get_width() / 2
        const pcy = surface.get_position_y() + surface.get_height() / 2
        let newSide: ArrowSide
        let newOffset: number
        if (requestedSide === "top" || requestedSide === "bottom") {
            newSide = pcy > wcy ? "top" : "bottom"    // bubble below widget → arrow up
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
            // "layout" fires whenever the compositor (re)positions the popup —
            // including the initial configure, before the first frame is drawn.
            layoutId = s.connect("layout", () => syncPlacement())
        }
        syncPlacement()
    })
    popover.connect("unmap", () => {
        if (layoutSurface && layoutId !== null) layoutSurface.disconnect(layoutId)
        layoutSurface = null; layoutId = null
    })

    // Repaint the glass when the appearance/opacity changes (mode toggle, slider).
    const themeId = Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })

    const refresh = () => {
        const value = typeof textSource === "function" ? textSource() : textSource
        if (markup) label.set_markup(value)
        else label.set_label(value)
    }

    let timer: number | null = null
    const cancelTimer = () => { if (timer !== null) { GLib.source_remove(timer); timer = null } }

    const motion = new Gtk.EventControllerMotion()
    motion.connect("motion", () => {
        if (suppress?.()) return
        if (popover.visible || timer !== null) return
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            timer = null
            refresh()               // pull the freshest text right before showing
            popover.popup()
            return GLib.SOURCE_REMOVE
        })
    })
    motion.connect("leave", () => { cancelTimer(); popover.popdown() })
    widget.add_controller(motion)

    let destroyed = false
    const destroy = () => {
        if (destroyed) return
        destroyed = true
        cancelTimer()
        Theme.disconnect(themeId)
        popover.popdown()
        popover.unparent()
    }
    // Auto-clean when the host goes away — tray items, app-grid tiles and the
    // About window are all created/destroyed at runtime.
    widget.connect("destroy", destroy)

    return {
        popover,
        setText: (t) => { textSource = t },
        destroy,
    }
}
