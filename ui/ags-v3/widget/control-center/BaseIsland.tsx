import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import { WidgetSize } from "./Types"

/**
 *  BaseIsland: The Absolute Law
 * I will NOT force expansion on children anymore. Let them decide.
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
        css_classes: ["atomic-island-win", "transparent"],
        visible: false
    })

    win.set_size_request(width, height)
    win.set_default_size(width, height)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "glass-test")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, y)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, x)

        // @ts-ignore
        win.gdkmonitor = monitor
    } catch (e) {
        console.error(`[BaseIsland] Shell error for ${name}:`, e)
    }

    let shape = Shape.SQUIRCLE
    let radius = 28
    if (size === WidgetSize.SINGLE) { shape = Shape.CIRCLE; radius = width / 2 }
    else if (size === WidgetSize.WIDE) { shape = Shape.CAPSULE; radius = height / 2 }
    else if (size === WidgetSize.FULL_WIDTH) { shape = Shape.SQUIRCLE; radius = 32 }

    //  ARCHITECTURAL CHANGE: DO NOT FORCE VEXPAND
    // This allows children to stay together if they don't want to expand.
    child.halign = Gtk.Align.FILL
    child.valign = Gtk.Align.FILL

    const island = SquircleContainer({
        child,
        radius,
        n: 4.5,
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
    win.toggle = () => win.visible = !win.visible

    return win
}
