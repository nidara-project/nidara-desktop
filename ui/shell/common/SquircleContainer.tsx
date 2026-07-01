import { Gtk } from "ags/gtk4"
import { drawSquircle, hexToFloatRgb } from "./DrawingUtils"
import Theme from "../core/ThemeManager"

export enum Shape {
    SQUIRCLE,
    CIRCLE,
    CAPSULE,
    DOCK_PILL
}

interface SquircleContainerProps {
    child: Gtk.Widget
    radius?: number
    gloss?: boolean
    css_classes?: string[]
    hexpand?: boolean
    vexpand?: boolean
    color?: { r: number, g: number, b: number }
    alpha?: number
    hoverColor?: { r: number, g: number, b: number }
    hoverAlpha?: number
    onClick?: () => void
    perfect?: boolean
    borderColor?: { r: number, g: number, b: number, a: number }
    hoverBorderColor?: { r: number, g: number, b: number, a: number }
    /** On hover, paint the border with the current accent at full opacity. */
    hoverBorderAccent?: boolean
    n?: number
    shape?: Shape
    borderWidth?: number
    margin?: number
    inset?: number
    padding?: number
    useShellOpacity?: boolean
    /** This capsule belongs to the shell skin: its glass tint follows
     *  Theme.chromeIsDark (pinned by appearance.shellAppearance, legible over any
     *  wallpaper) instead of the system mode. DEFAULT true — every bar/dock/overlay
     *  capsule is shell skin. Pass `chrome: false` ONLY for app-mode windows
     *  (About) that should follow the system mode like a third-party app. */
    chrome?: boolean
    /** Which opacity this capsule's glass tracks when useShellOpacity is set:
     *  "bar" → Theme.barOpacity, "overlay" (default) → Theme.overlayOpacity.
     *  (The dock paints from Theme.dockOpacity directly in DockAxis.) */
    opacityRole?: "bar" | "overlay"
    /** Active/"on" fill — while this returns true, the WHOLE capsule paints with
     *  the live accent colour instead of the base glass (macOS/GNOME/Windows
     *  quick-settings convention: a toggle's on-state fills its entire tile, not
     *  just its icon). Read live inside the draw call, so an accent change repaints
     *  for free via the Theme "changed" redraw below — no separate wiring needed. */
    getActive?: () => boolean
    /** Static alpha (default 0.85), or a getter for a live-varying one — a
     *  recording indicator pulsing between two alphas reads it every redraw, so
     *  `watchActive` just needs to tick a redraw timer for the pulse to animate. */
    activeAlpha?: number | (() => number)
    /** Override which colour "active" fills with — a hex string, resolved through
     *  `hexToFloatRgb`. Omit to use the live theme accent (every toggle tile:
     *  dark_mode, bt, vpn, …). Set for a FIXED semantic colour that must NOT move
     *  with the user's accent choice — e.g. screen recording uses `DANGER_HEX`,
     *  same red as every other "this needs attention" indicator. */
    activeColorHex?: string
    /** Notifies this container to redraw when the active state flips (the
     *  container has no way to know on its own — it's driven by the caller's own
     *  domain signal, e.g. BluetoothService.watchPower). */
    watchActive?: (cb: () => void) => (() => void)
    /** Fractional variant of getActive — 0..1, fills that fraction of the shape
     *  from the BOTTOM with the live accent (a "gauge": CC slider tiles), the rest
     *  with the base glass, as ONE continuous shape/border (see drawSquircle's
     *  fillFrac) instead of a separately-drawn inner fill layer. Takes priority
     *  over getActive when both are given (in practice, never both). Read live
     *  inside the draw call and re-queued via watchActive, same as getActive. */
    getFill?: () => number
}

/** Resolves a shape's actual paint params for an allocated size. CIRCLE/CAPSULE
 *  always collapse to a perfect arc sized to the smaller dimension (the curve
 *  must follow the shape's own footprint, not a caller's guessed radius);
 *  DOCK_PILL/SQUIRCLE use the requested radius/n as-is. Exported so anything
 *  painting a squircle outside this component (e.g. the CC drag ghost) stays in
 *  lockstep with how a real tile renders instead of re-deriving the mapping. */
export function resolveDrawParams(
    shape: Shape, radius: number, n: number, perfect: boolean, w: number, h: number,
): { radius: number; n: number; perfect: boolean } {
    if (shape === Shape.CIRCLE || shape === Shape.CAPSULE) {
        return { radius: Math.min(w, h) / 2, n: 2.0, perfect: true }
    }
    if (shape === Shape.DOCK_PILL) {
        return { radius: radius || 24, n: 3.2, perfect }
    }
    return { radius, n, perfect }
}

export default function SquircleContainer({
    child,
    radius = 24,
    gloss = false,
    css_classes = [],
    hexpand = false,
    vexpand = false,
    color,
    alpha,
    hoverColor,
    hoverAlpha,
    onClick,
    perfect = false,
    borderColor,
    hoverBorderColor,
    hoverBorderAccent = false,
    n = 3.2,
    shape = Shape.SQUIRCLE,
    borderWidth = 1.0,
    inset,
    padding,
    useShellOpacity = false,
    chrome = true,
    opacityRole = "overlay",
    getActive,
    activeAlpha = 0.85,
    activeColorHex,
    watchActive,
    getFill,
}: SquircleContainerProps) {
    const container = new Gtk.Grid({
        css_classes,
        hexpand,
        vexpand
    })

    const da = new Gtk.DrawingArea({
        hexpand: true,
        vexpand: true
    })

    let isHovered = false
    const techInset = inset !== undefined ? inset : 2.0

    if (useShellOpacity || chrome) {
        Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
    }

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        // Shell-skin capsules (default) follow the pinned shell appearance;
        // app-mode surfaces (chrome:false, e.g. About) follow the system mode.
        const dark = chrome ? Theme.chromeIsDark : Theme.isDark
        const themeColor = dark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        const baseColor = color || (useShellOpacity ? themeColor : { r: 1, g: 1, b: 1 })
        // Explicit alpha always wins (even with useShellOpacity, so a surface can
        // stay theme-coloured + redraw-on-toggle yet be near-opaque — e.g. the CC
        // context menu, which floats over content with no real internal blur).
        const baseAlpha = alpha !== undefined ? alpha : (useShellOpacity ? (opacityRole === "bar" ? Theme.barOpacity : Theme.overlayOpacity) : 0.05)
        let shareColor = baseColor
        let shareAlpha = baseAlpha
        let shareBorder = borderColor
        let fillFrac: number | undefined = undefined

        if (getFill || getActive) {
            const frac = getFill ? Math.max(0, Math.min(1, getFill())) : (getActive!() ? 1 : 0)
            if (frac > 0) {
                const activeColor = hexToFloatRgb(activeColorHex ?? Theme.accentPalette[Theme.accentColor].color)
                const resolvedAlpha = typeof activeAlpha === "function" ? activeAlpha() : activeAlpha
                if (frac >= 1) {
                    shareColor = activeColor
                    shareAlpha = resolvedAlpha
                } else {
                    fillFrac = frac
                    shareColor = activeColor  // the FILLED (bottom) portion
                    shareAlpha = resolvedAlpha  // baseColor/baseAlpha (still held above) become the empty portion
                }
            }
        }

        if (isHovered) {
            if (hoverColor) shareColor = hoverColor
            if (hoverAlpha !== undefined) shareAlpha = hoverAlpha
            if (hoverBorderColor) shareBorder = hoverBorderColor
            if (hoverBorderAccent) {
                // Read the accent live so the outline tracks accent changes.
                shareBorder = { ...hexToFloatRgb(Theme.accentPalette[Theme.accentColor].color), a: 1 }
            }
        }

        // Gtk4 provides a clean surface; OVER is the standard blending mode.
        cr.setOperator(2) // OVER

        const { radius: drawRadius, n: drawN, perfect: drawPerfect } = resolveDrawParams(shape, radius, n, perfect, w, h)

        drawSquircle(
            cr, w, h, undefined,
            shareAlpha, gloss, shareColor,
            drawRadius, drawPerfect, shareBorder,
            drawN, borderWidth, techInset,
            undefined, fillFrac, baseColor, baseAlpha,
        )
    })

    const grid = new Gtk.Grid({
        css_classes,
        hexpand,
        vexpand
    })

    // Background first (bottom)
    da.hexpand = true
    da.vexpand = true
    da.halign = Gtk.Align.FILL
    da.valign = Gtk.Align.FILL
    grid.attach(da, 0, 0, 1, 1)

    if (padding !== undefined) {
        child.margin_top = padding
        child.margin_bottom = padding
        child.margin_start = padding
        child.margin_end = padding
    }

    // Content second (top)
    grid.attach(child, 0, 0, 1, 1)

    if (hoverColor || hoverAlpha !== undefined || hoverBorderColor || hoverBorderAccent || onClick) {
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => { isHovered = true; da.queue_draw() })
        motion.connect("leave", () => { isHovered = false; da.queue_draw() })
        grid.add_controller(motion)
    }

    if (onClick) {
        const click = new Gtk.GestureClick()
        click.connect("pressed", () => onClick())
        grid.add_controller(click)
    }

    if (watchActive) {
        const cleanup = watchActive(() => { if (da.get_mapped()) da.queue_draw() })
        grid.connect("unrealize", cleanup)
    }

    return grid
}
