import { Gtk } from "ags/gtk4"
import { drawSquircle } from "./DrawingUtils"

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
    n = 4.0,
    shape = Shape.SQUIRCLE,
    borderWidth = 1.0
}: SquircleContainerProps) {
    // Use Gtk.Grid as a Z-Stack.
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

    da.set_draw_func((_, cr, w, h) => {
        // Determine current style
        const baseColor = color || { r: 1, g: 1, b: 1 }
        const baseAlpha = alpha !== undefined ? alpha : 0.05

        let shareColor = baseColor
        let shareAlpha = baseAlpha
        let shareBorder = borderColor

        if (isHovered) {
            if (hoverColor) shareColor = hoverColor
            if (hoverAlpha !== undefined) shareAlpha = hoverAlpha
            if (hoverBorderColor) shareBorder = hoverBorderColor
        }

        cr.setSourceRGBA(0, 0, 0, 0); cr.paint()

        let drawRadius = radius
        let drawN = n
        let drawPerfect = perfect

        if (shape === Shape.SQUIRCLE) {
            drawRadius = radius
            drawN = n
        } else if (shape === Shape.CIRCLE) {
            drawRadius = Math.min(w, h) / 2
            drawN = 2.0 // Perfect Circle
            drawPerfect = true
        } else if (shape === Shape.CAPSULE) {
            drawRadius = Math.min(w, h) / 2
            drawN = 5.0 // Higher curvature for pill ends
            drawPerfect = true
        } else if (shape === Shape.DOCK_PILL) {
            drawRadius = 24 // Standardized dock radius
            drawN = 3.2
        }

        drawSquircle(cr, w, h, undefined, shareAlpha, gloss, shareColor, drawRadius, drawPerfect, shareBorder, drawN, borderWidth)
    })

    // 1. Attach Background (Behind)
    container.attach(da, 0, 0, 1, 1)

    // Center content for all shapes
    child.halign = Gtk.Align.CENTER
    child.valign = Gtk.Align.CENTER
    child.hexpand = true
    child.vexpand = true

    // 2. Attach Content (On Top)
    container.attach(child, 0, 0, 1, 1)

    // Interactive Controllers
    if (hoverColor || hoverAlpha !== undefined || onClick) {
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => {
            isHovered = true
            da.queue_draw()
        })
        motion.connect("leave", () => {
            isHovered = false
            da.queue_draw()
        })
        container.add_controller(motion)
    }

    if (onClick) {
        const click = new Gtk.GestureClick()
        click.connect("pressed", () => onClick())
        container.add_controller(click)
    }

    return container
}
