import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Shape } from "../common/SquircleContainer"
import { AtomicWidget, WidgetSize } from "./Types"

export function SliderWidget(id: string, name: string, iconName: string, label: string, initialValue: number, onChange: (v: number) => void): AtomicWidget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        css_classes: ["cc-atomic-slider-box-horizontal"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true
    })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10, value: initialValue })
    })
    scale.set_size_request(240, -1)
    scale.add_css_class("cc-atomic-scale-native")
    scale.add_css_class("crystal-scale")

    const iconLow = new Gtk.Image({
        icon_name: id === "volume" ? "audio-volume-low-symbolic" : "display-brightness-symbolic",
        pixel_size: 16,
        css_classes: ["cc-atomic-slider-icon-side"]
    })

    const iconHigh = new Gtk.Image({
        icon_name: iconName,
        pixel_size: 16,
        css_classes: ["cc-atomic-slider-icon-side"]
    })

    box.append(iconLow)
    box.append(scale)
    box.append(iconHigh)

    scale.connect("value-changed", () => onChange(scale.get_value() / 100))

    return {
        id,
        name,
        size: WidgetSize.FULL_WIDTH,
        child: box
    }
}
