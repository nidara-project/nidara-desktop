import { Gtk } from "ags/gtk4"

import { AtomicWidget, WidgetSize } from "./Types"

export function SliderWidget(id: string, name: string, iconNameHigh: string, _label: string, initialValue: number, onChange: (v: number) => void): AtomicWidget {
    const iconNameLow = id === "volume" ? "audio-volume-low-symbolic" : "display-brightness-symbolic"

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        css_classes: ["cc-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: false,
        margin_start: 4,
        margin_end: 4,
    })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        draw_value: false,
        css_classes: ["crystal-scale", "cc-atomic-scale-native"],
    })
    scale.set_range(0, 100)
    scale.set_value(initialValue)
    scale.set_increments(2, 10)

    const iconLow = new Gtk.Image({
        icon_name: iconNameLow,
        pixel_size: 16,
        opacity: 0.6,
        valign: Gtk.Align.CENTER,
    })

    const iconHigh = new Gtk.Image({
        icon_name: iconNameHigh,
        pixel_size: 16,
        opacity: 0.6,
        valign: Gtk.Align.CENTER,
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(initialValue)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 4,
        valign: Gtk.Align.CENTER,
    })

    box.append(iconLow)
    box.append(scale)
    box.append(iconHigh)
    box.append(valueLabel)

    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        onChange(v / 100)
    })

    return {
        id,
        name,
        size: WidgetSize.FULL_WIDTH,
        child: box,
    }
}
