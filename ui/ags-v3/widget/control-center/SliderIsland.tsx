import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import { execAsync } from "ags/process"
import SquircleContainer from "../common/SquircleContainer"

export default function SliderIsland(gdkmonitor: Gdk.Monitor, topMargin: number = 280) {
    const win = new Gtk.Window({
        name: "cc-sliders-island-win",
        application: app,
        css_classes: ["control-center-win", "transparent"],
        visible: false,
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, false)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, topMargin)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 8)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) { }

    const slidersContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders-content"],
        margin_top: 16, margin_start: 16, margin_end: 16, margin_bottom: 16,
        width_request: 348
    })

    const slidersIsland = SquircleContainer({
        child: slidersContent,
        radius: 32,
        n: 4.5,
        css_classes: ["cc-island", "cc-sliders-island"],
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.02 },
        inset: 3.0,
        padding: 8
    })

    const volScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10 })
    })

    const brightScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10 })
    })

    const createSlider = (iconName: string, scale: Gtk.Scale, onChanged: (v: number) => void) => {
        scale.set_size_request(-1, 48)
        scale.add_css_class("cc-pill-slider")
        const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 16, halign: Gtk.Align.START, valign: Gtk.Align.CENTER, margin_start: 16 })
        const sliderOverlay = new Gtk.Overlay()
        sliderOverlay.set_child(scale)
        sliderOverlay.add_overlay(icon)
        scale.connect("value-changed", () => onChanged(scale.get_value() / 100))
        return sliderOverlay
    }

    slidersContent.append(createSlider("audio-volume-high-symbolic", volScale, (v) => execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v.toFixed(2)}`)))
    slidersContent.append(createSlider("display-brightness-symbolic", brightScale, (v) => execAsync(`brightnessctl s ${Math.floor(v * 100)}%`)))

    win.set_child(slidersIsland)

    // @ts-ignore
    win.toggle = () => {
        win.set_visible(!win.get_visible())
    }

    return win
}
