import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import SquircleContainer, { Shape } from "../common/SquircleContainer"

interface BaseIslandProps {
    name: string
    child: Gtk.Widget
    monitor: Gdk.Monitor
    x: number // Margin-Right
    y: number // Margin-Top
    width?: number
    height?: number
    alpha?: number
    radius?: number
    gloss?: boolean
    shape?: Shape
}

export default function BaseIsland({
    name,
    child,
    monitor,
    x,
    y,
    width,
    height,
    alpha = 0.15,
    radius = 24,
    gloss = true,
    shape = Shape.SQUIRCLE
}: BaseIslandProps): Gtk.Window {
    const win = new Gtk.Window({
        name: `atomic-island-${name}`,
        application: app,
        width_request: width,
        height_request: height,
        decorated: false,
        css_classes: ["atomic-island-win", "transparent"],
        visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "glass-test")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, false)

        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, y)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, x)

        // @ts-ignore
        win.gdkmonitor = monitor
    } catch (e) {
        console.error(`[BaseIsland] Shell error for ${name}:`, e)
    }

    const island = SquircleContainer({
        child,
        radius,
        gloss,
        alpha,
        shape,
        css_classes: ["cc-island", `cc-${name}-island`],
        borderColor: { r: 1, g: 1, b: 1, a: 0.02 }
    })

    island.hexpand = true
    island.vexpand = true
    island.halign = Gtk.Align.FILL
    island.valign = Gtk.Align.FILL

    if (width) island.width_request = width
    if (height) island.height_request = height

    win.set_child(island)

    // @ts-ignore
    win.toggle = () => win.visible = !win.visible

    return win
}
