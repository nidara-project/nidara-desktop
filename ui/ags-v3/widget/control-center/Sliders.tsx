import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalWp from "gi://AstalWp"
import { makeHSlider } from "../common/Slider"
import { AtomicWidget, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

function buildHorizontalSlider(
    iconNameLow: string,
    iconNameHigh: string,
    getValue: () => number,
    onChange: (v: number) => void,
    onExtChange: (cb: (v: number) => void) => (() => void),
): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        css_classes: ["cc-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: false,
        margin_start: 4, margin_end: 4,
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    const sliderWidget = makeHSlider({
        value: getValue(),
        onChange: (v) => onChange(v / 100),
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => onExtChange((v) => cb(Math.round(v * 100))),
    })

    box.append(new Gtk.Image({ icon_name: iconNameLow,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(sliderWidget)
    box.append(new Gtk.Image({ icon_name: iconNameHigh, pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(valueLabel)

    return box
}

function buildVerticalSlider(
    iconName: string,
    getValue: () => number,
    onChange: (v: number) => void,
    onExtChange: (cb: (v: number) => void) => (() => void),
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
        inverted: true,
        css_classes: ["crystal-scale", "cc-atomic-scale-native", "cc-scale-vertical"],
        width_request: 32,
    })
    scale.set_range(0, 100)
    scale.set_value(getValue())
    scale.set_increments(1, 5)

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        halign: Gtk.Align.CENTER,
        width_chars: 5,
    })

    box.append(icon)
    box.append(scale)
    box.append(valueLabel)

    let ignoreUntil = 0, pending = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        ignoreUntil = GLib.get_monotonic_time() + 300_000
        if (!pending) {
            pending = true
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                onChange(scale.get_value() / 100)
                pending = false
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const cleanup = onExtChange((v) => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
        const val = Math.round(v * 100)
        if (Math.abs(scale.get_value() - val) > 1) scale.set_value(val)
    })
    box.connect("unrealize", cleanup)

    return box
}

export function VolumeWidget(): AtomicWidget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getValue = () => speaker ? Math.round(speaker.volume * 100) / 100 : 0.5
    const onChange = (v: number) => { if (speaker) speaker.volume = v }
    const onExtChange = (cb: (v: number) => void): (() => void) => {
        if (!speaker) return () => {}
        const id = speaker.connect("notify::volume", () => cb(speaker.volume))
        return () => { try { speaker.disconnect(id) } catch {} }
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        const current = getValue()
        if (size === WidgetSize.TALL) {
            return buildVerticalSlider(Icons.volumeHigh, () => current * 100, onChange, onExtChange)
        }
        return buildHorizontalSlider(Icons.volumeLow, Icons.volumeHigh, () => current * 100, onChange, onExtChange)
    }

    return {
        id: "volume",
        name: t("cc.volume.name"),
        defaultSize: WidgetSize.FULL_WIDTH,
        supportedSizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],
        buildContent,
    }
}
