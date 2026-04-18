import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { AtomicWidget, WidgetSize } from "./Types"
import { t } from "../../core/i18n"

function buildHorizontalSlider(
    iconNameLow: string,
    iconNameHigh: string,
    getValue: () => number,
    onChange: (v: number) => void,
    onExternalChange: (cb: (v: number) => void) => (() => void),
): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        css_classes: ["cc-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: false,
        margin_start: 4, margin_end: 4,
    })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true, valign: Gtk.Align.CENTER,
        draw_value: false,
        css_classes: ["crystal-scale", "cc-atomic-scale-native"],
    })
    scale.set_range(0, 100)
    scale.set_value(getValue())
    scale.set_increments(2, 10)

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        width_chars: 4, valign: Gtk.Align.CENTER,
    })

    box.append(new Gtk.Image({ icon_name: iconNameLow,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(scale)
    box.append(new Gtk.Image({ icon_name: iconNameHigh, pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(valueLabel)

    let ignoreExternal = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        ignoreExternal = true
        onChange(v / 100)
        ignoreExternal = false
    })

    const cleanup = onExternalChange((v) => {
        if (ignoreExternal) return
        const val = Math.round(v * 100)
        if (Math.abs(scale.get_value() - val) > 1) {
            scale.set_value(val)
            valueLabel.label = `${val}%`
        }
    })
    box.connect("unrealize", cleanup)

    return box
}

function buildVerticalSlider(
    iconName: string,
    getValue: () => number,
    onChange: (v: number) => void,
    onExternalChange: (cb: (v: number) => void) => (() => void),
): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.FILL,
        vexpand: true,
        margin_top: 10, margin_bottom: 10,
    })

    const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 18, halign: Gtk.Align.CENTER })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true, halign: Gtk.Align.CENTER,
        draw_value: false,
        inverted: true,   // top = max, bottom = min (natural feel)
        css_classes: ["crystal-scale", "cc-atomic-scale-native", "cc-scale-vertical"],
        width_request: 32,
    })
    scale.set_range(0, 100)
    scale.set_value(getValue())
    scale.set_increments(2, 10)

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        halign: Gtk.Align.CENTER,
    })

    box.append(icon)
    box.append(scale)
    box.append(valueLabel)

    let ignoreExternal = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        ignoreExternal = true
        onChange(v / 100)
        ignoreExternal = false
    })

    const cleanup = onExternalChange((v) => {
        if (ignoreExternal) return
        const val = Math.round(v * 100)
        if (Math.abs(scale.get_value() - val) > 1) {
            scale.set_value(val)
            valueLabel.label = `${val}%`
        }
    })
    box.connect("unrealize", cleanup)

    return box
}

export function VolumeWidget(): AtomicWidget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getValue = () => speaker ? Math.round(speaker.volume * 100) / 100 : 0.5
    const onChange = (v: number) => { if (speaker) speaker.volume = v }

    const onExternalChange = (cb: (v: number) => void): (() => void) => {
        if (!speaker) return () => {}
        const id = speaker.connect("notify::volume", () => cb(speaker.volume))
        return () => { try { speaker.disconnect(id) } catch {} }
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        const current = getValue()
        if (size === WidgetSize.TALL) {
            return buildVerticalSlider(
                "audio-volume-high-symbolic",
                () => current * 100,
                onChange,
                onExternalChange,
            )
        }
        return buildHorizontalSlider(
            "audio-volume-low-symbolic",
            "audio-volume-high-symbolic",
            () => current * 100,
            onChange,
            onExternalChange,
        )
    }

    return {
        id: "volume",
        name: t("cc.volume.name"),
        defaultSize: WidgetSize.FULL_WIDTH,
        supportedSizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],
        buildContent,
    }
}
