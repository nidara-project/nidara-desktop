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
    monitor: Gdk.Monitor
    x: number
    y: number
    width: number
    height: number
    size: WidgetSize
    alpha?: number
    gloss?: boolean
}

export default function BaseIsland({
    name,
    child,
    monitor,
    x,
    y,
    width,
    height,
    size,
    alpha = 0.15,
    gloss = true
}: BaseIslandProps): Gtk.Window {
    const win = new Gtk.Window({
        name: `atomic-island-${name}`,
        application: app,
        decorated: false,
        resizable: false,
        css_classes: ["atomic-island-win"],
        visible: false
    })

    win.set_size_request(width, height)
    win.set_default_size(width, height)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_monitor(win, monitor)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, y)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, x)

        // @ts-ignore
        win.gdkmonitor = monitor
    } catch (e) {
        console.error(`[BaseIsland] Shell error for ${name}:`, e)
    }

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
        shape,
        css_classes: ["cc-island", `cc-${name}-island`],
        inset: 2.0,
        padding: 12
    })

    island.set_size_request(width, height)
    win.set_child(island)

    // @ts-ignore
    //win.toggle = () => win.visible = !win.visible

    return win
}
