import { Gtk } from "ags/gtk4"
import { drawSquircle } from "./DrawingUtils"
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

        if (isHovered) {
            if (hoverColor) shareColor = hoverColor
            if (hoverAlpha !== undefined) shareAlpha = hoverAlpha
            if (hoverBorderColor) shareBorder = hoverBorderColor
            if (hoverBorderAccent) {
                // Read the accent live so the outline tracks accent changes.
                const hex = Theme.accentPalette[Theme.accentColor].color
                shareBorder = {
                    r: parseInt(hex.slice(1, 3), 16) / 255,
                    g: parseInt(hex.slice(3, 5), 16) / 255,
                    b: parseInt(hex.slice(5, 7), 16) / 255,
                    a: 1,
                }
            }
        }

        // Gtk4 provides a clean surface; OVER is the standard blending mode.
        cr.setOperator(2) // OVER

        const { radius: drawRadius, n: drawN, perfect: drawPerfect } = resolveDrawParams(shape, radius, n, perfect, w, h)

        drawSquircle(
            cr, w, h, undefined,
            shareAlpha, gloss, shareColor,
            drawRadius, drawPerfect, shareBorder,
            drawN, borderWidth, techInset
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

    return grid
}
