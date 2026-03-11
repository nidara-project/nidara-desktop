import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Shape } from "../common/SquircleContainer"
import { AtomicWidget } from "./Types"

export function SliderWidget(id: string, name: string, iconName: string, label: string, grid: { x: number, y: number }, initialValue: number, onChange: (v: number) => void): AtomicWidget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        css_classes: ["cc-atomic-slider-box"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true
    })

    const title = new Gtk.Label({ label, css_classes: ["cc-atomic-label-small"], halign: Gtk.Align.START })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10, value: initialValue })
    })
    scale.add_css_class("cc-pill-slider")

    const icon = new Gtk.Image({
        icon_name: iconName,
        pixel_size: 14,
        css_classes: ["cc-pill-slider-icon"],
        halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
        margin_start: 12
    })

    const overlay = new Gtk.Overlay()
    overlay.set_child(scale)
    overlay.add_overlay(icon)

    box.append(title)
    box.append(overlay)

    scale.connect("value-changed", () => onChange(scale.get_value() / 100))

    return {
        id,
        name,
        grid: { ...grid, w: 4, h: 1 },
        shape: Shape.DOCK_PILL,
        child: box
    }
}
