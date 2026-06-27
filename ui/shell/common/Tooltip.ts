import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"
import { ARROW_H, BUF, sideFor, paintGlassBubble } from "./GlassBubble"

export type NidaraTooltipText = string | (() => string)

export interface NidaraTooltipOpts {
    /** Where the bubble sits relative to the widget (default: TOP). NOTE: pick a
     *  side with room so GTK doesn't auto-flip — the Cairo arrow is painted on the
     *  requested side (e.g. a top-bar item should pass BOTTOM). */
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
    const side = sideFor(position)

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
    da.set_draw_func((_da, cr, w, h) => paintGlassBubble(cr, w, h, side, { chrome }))
    grid.attach(da, 0, 0, 1, 1)

    const label = new Gtk.Label({ css_classes: ["nidara-tooltip-label"] })
    label.margin_top    = BUF + PAD_Y + (side === "top"    ? ARROW_H : 0)
    label.margin_bottom = BUF + PAD_Y + (side === "bottom" ? ARROW_H : 0)
    label.margin_start  = BUF + PAD_X + (side === "left"   ? ARROW_H : 0)
    label.margin_end    = BUF + PAD_X + (side === "right"  ? ARROW_H : 0)
    grid.attach(label, 0, 0, 1, 1)

    popover.set_child(grid)
    popover.set_parent(widget)

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
