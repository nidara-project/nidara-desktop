import { Gtk } from "ags/gtk4"
import { drawSquircle } from "./DrawingUtils"
import Theme from "../../core/ThemeManager"

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
    n?: number
    shape?: Shape
    borderWidth?: number
    margin?: number
    inset?: number
    padding?: number
    useShellOpacity?: boolean
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
    n = 3.2,
    shape = Shape.SQUIRCLE,
    borderWidth = 1.0,
    inset,
    padding,
    useShellOpacity = false,
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

    if (useShellOpacity) {
        Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
    }

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const themeColor = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        const baseColor = color || (useShellOpacity ? themeColor : { r: 1, g: 1, b: 1 })
        // Explicit alpha always wins (even with useShellOpacity, so a surface can
        // stay theme-coloured + redraw-on-toggle yet be near-opaque — e.g. the CC
        // context menu, which floats over content with no real internal blur).
        const baseAlpha = alpha !== undefined ? alpha : (useShellOpacity ? Theme.shellOpacity : 0.05)
        let shareColor = baseColor
        let shareAlpha = baseAlpha
        let shareBorder = borderColor

        if (isHovered) {
            if (hoverColor) shareColor = hoverColor
            if (hoverAlpha !== undefined) shareAlpha = hoverAlpha
            if (hoverBorderColor) shareBorder = hoverBorderColor
        }

        // Gtk4 provides a clean surface; OVER is the standard blending mode.
        cr.setOperator(2) // OVER

        let drawRadius = radius
        let drawN = n
        let drawPerfect = perfect

        if (shape === Shape.CIRCLE || shape === Shape.CAPSULE) {
            drawRadius = Math.min(w, h) / 2
            drawN = 2.0
            drawPerfect = true
        } else if (shape === Shape.DOCK_PILL) {
            drawRadius = radius || 24
            drawN = 3.2
        }

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

    if (hoverColor || hoverAlpha !== undefined || onClick) {
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
