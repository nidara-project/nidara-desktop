import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import { WidgetSize } from "./Types"

/**
 *  BaseIsland: Geometric Identity
 * - 2x1 (WIDE): Force perfect Capsules 💊
 * - 2x2/4x1: Sync with Dock System (n=3.2)
 */
interface BaseIslandProps {
    name: string
    child: Gtk.Widget
    width: number
    height: number
    size: WidgetSize
    alpha?: number
    gloss?: boolean
}

export default function BaseIsland({
    name,
    child,
    width,
    height,
    size,
    alpha,
    gloss = true
}: BaseIslandProps): Gtk.Widget {

    //  GEOMETRIC RULES:
    let shape = Shape.SQUIRCLE
    let radius = 28
    let n = 3.2 // Tahoe Standard

    if (size === WidgetSize.SINGLE) {
        shape = Shape.CIRCLE
        radius = width / 2
    } else if (size === WidgetSize.WIDE) {
        // 🔒 2x1: CAPSULAS PERFECTAS (Semicircles)
        shape = Shape.CAPSULE
        radius = height / 2
    } else if (size === WidgetSize.FULL_WIDTH) {
        // 4x1: Sync with Dock profile
        shape = Shape.DOCK_PILL
        radius = height / 2
    } else {
        // 2x2: Squircle with Dock profile
        shape = Shape.SQUIRCLE
        radius = 32
    }

    child.halign = Gtk.Align.FILL
    child.valign = Gtk.Align.FILL

    const island = SquircleContainer({
        child,
        radius,
        n,
        borderWidth: 1.5,
        gloss,
        alpha,
        useShellOpacity: alpha === undefined,
        shape,
        css_classes: ["cc-island", `cc-${name}-island`],
        inset: 2.0,
        padding: 12
    })

    island.set_size_request(width, height)
    return island
}
