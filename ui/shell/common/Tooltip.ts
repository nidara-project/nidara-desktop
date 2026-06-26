import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"

export type NidaraTooltipText = string | (() => string)
type ArrowSide = "top" | "bottom" | "left" | "right"

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

// Geometry. The body is a near-pill squircle; the pointer is spliced into the
// centre of the arrow side so the silhouette is one continuous shape.
const ARROW_W = 14   // base width of the pointer
const ARROW_H = 7    // how far it protrudes from the body
const PAD_X = 11     // text padding inside the body (horizontal)
const PAD_Y = 6      // text padding inside the body (vertical)
const BUF = 2        // AA buffer so the silhouette never clips the DrawingArea edge
const BORDER_W = 1   // inner edge width

const sideFor = (pos: Gtk.PositionType): ArrowSide => {
    switch (pos) {
        case Gtk.PositionType.BOTTOM: return "top"
        case Gtk.PositionType.LEFT:   return "right"
        case Gtk.PositionType.RIGHT:  return "left"
        default:                      return "bottom" // TOP
    }
}

// ONE continuous path: a rounded rect (perfect arcs) with a triangular pointer
// spliced into the centre of `side`. Fill it for the glass body; stroke it
// (clipped to itself) for the 1px inner edge — the rim then wraps body AND arrow
// as a single outline, which is the whole reason this is Cairo and not a GTK
// popover arrow (whose base seam shows through translucent glass).
const bubblePath = (cr: any, x: number, y: number, w: number, h: number, r: number, side: ArrowSide) => {
    const x2 = x + w, y2 = y + h
    const cx = x + w / 2, cy = y + h / 2
    const HALF = Math.PI / 2
    cr.moveTo(x + r, y)
    if (side === "top")    { cr.lineTo(cx - ARROW_W / 2, y);  cr.lineTo(cx, y - ARROW_H);   cr.lineTo(cx + ARROW_W / 2, y) }
    cr.lineTo(x2 - r, y)
    cr.arc(x2 - r, y + r, r, -HALF, 0)                        // top-right
    if (side === "right")  { cr.lineTo(x2, cy - ARROW_W / 2); cr.lineTo(x2 + ARROW_H, cy); cr.lineTo(x2, cy + ARROW_W / 2) }
    cr.lineTo(x2, y2 - r)
    cr.arc(x2 - r, y2 - r, r, 0, HALF)                        // bottom-right
    if (side === "bottom") { cr.lineTo(cx + ARROW_W / 2, y2); cr.lineTo(cx, y2 + ARROW_H);  cr.lineTo(cx - ARROW_W / 2, y2) }
    cr.lineTo(x + r, y2)
    cr.arc(x + r, y2 - r, r, HALF, Math.PI)                   // bottom-left
    if (side === "left")   { cr.lineTo(x, cy + ARROW_W / 2);  cr.lineTo(x - ARROW_H, cy);  cr.lineTo(x, cy - ARROW_W / 2) }
    cr.lineTo(x, y + r)
    cr.arc(x + r, y + r, r, Math.PI, 3 * HALF)                // top-left
    cr.closePath()
}

const paintBubble = (cr: any, w: number, h: number, side: ArrowSide, chrome: boolean) => {
    if (w <= 0 || h <= 0) return
    // Shell skin follows the pinned appearance; app-mode (About) follows the system mode.
    const dark = chrome ? Theme.chromeIsDark : Theme.isDark
    const tint = dark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
    // Glass alpha tracks the overlay slider, but FLOORED at 0.38. This is a popup,
    // and Hyprland blurs popups with `popups_ignorealpha = 0.30` (NOT the bar/dock
    // layer's 0.01/0.04 — see hyprland.lua). Below that the bubble stops blurring
    // and reads flat (the bug at low overlay opacity). 0.38 mirrors NidaraTheme's
    // popover-bg floor `Math.max(bgAlpha, 0.38)` for exactly the same reason.
    // App-mode (About) is a normal window with no blur → keep it near-opaque.
    const alpha = chrome ? Math.max(Theme.overlayOpacity, 0.38) : 0.9

    // Body rect: inset by BUF all round, plus ARROW_H on the arrow side (the
    // pointer protrudes into that reserved strip).
    const bx = BUF + (side === "left" ? ARROW_H : 0)
    const by = BUF + (side === "top" ? ARROW_H : 0)
    const bw = w - 2 * BUF - ((side === "left" || side === "right") ? ARROW_H : 0)
    const bh = h - 2 * BUF - ((side === "top" || side === "bottom") ? ARROW_H : 0)
    if (bw <= 0 || bh <= 0) return

    // Near-pill radius, but clamped so the arrow base fits in the straight segment.
    let r = Math.min(bh, bw) / 2
    r = Math.min(r, 13)
    const edgeLen = (side === "top" || side === "bottom") ? bw : bh
    r = Math.min(r, (edgeLen - ARROW_W) / 2 - 2)
    r = Math.max(r, 4)

    cr.setOperator(2) // OVER

    // 1) Glass fill — AA (smooth silhouette).
    cr.save()
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, r, side)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, alpha)
    cr.fill()
    cr.restore()

    // 2) Inner edge — clip to the silhouette, then stroke it at double width so
    //    only the inner ~1px survives the clip (no outer AA spilling onto glass).
    cr.save()
    cr.setAntialias(1) // NONE for a crisp clip
    bubblePath(cr, bx, by, bw, bh, r, side)
    cr.clip()
    cr.setAntialias(2) // AA for a smooth stroke
    bubblePath(cr, bx, by, bw, bh, r, side)
    cr.setLineWidth(BORDER_W * 2)
    if (dark) cr.setSourceRGBA(1, 1, 1, 0.16)   // 1px inner white edge on dark glass
    else      cr.setSourceRGBA(0, 0, 0, 0.12)   // subtle dark rim for definition on light glass
    cr.stroke()
    cr.restore()
}

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
    da.set_draw_func((_da, cr, w, h) => paintBubble(cr, w, h, side, chrome))
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
