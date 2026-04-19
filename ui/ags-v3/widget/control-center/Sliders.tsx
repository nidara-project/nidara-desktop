import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
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
    scale.set_increments(1, 5)
    // Block GTK Range's absolute-position drag; keep scroll-wheel steps.
    scale.connect("change-value", (_s: Gtk.Scale, t: Gtk.ScrollType) =>
        t !== Gtk.ScrollType.STEP_UP && t !== Gtk.ScrollType.STEP_DOWN &&
        t !== Gtk.ScrollType.STEP_FORWARD && t !== Gtk.ScrollType.STEP_BACKWARD)

    // GestureClick (CAPTURE) claims the pointer sequence before GTK Range can,
    // denying its internal gesture. EventControllerMotion then tracks the delta.
    const click = new Gtk.GestureClick({ propagation_phase: Gtk.PropagationPhase.CAPTURE, button: 1 })
    const motion = new Gtk.EventControllerMotion({ propagation_phase: Gtk.PropagationPhase.CAPTURE })
    scale.add_controller(click)
    scale.add_controller(motion)
    let isDragging = false, dragStart = 0, startX = 0, trackW = 1
    click.connect("pressed", (_g: Gtk.GestureClick, _n: number, x: number) => {
        _g.set_state(Gtk.EventSequenceState.CLAIMED)
        isDragging = true
        dragStart = scale.get_value()
        startX = x
        trackW = Math.max(20, scale.get_width() - 20)
    })
    click.connect("released", () => { isDragging = false })
    motion.connect("motion", (_g: Gtk.EventControllerMotion, x: number) => {
        if (!isDragging) return
        const newVal = Math.max(0, Math.min(100, dragStart + ((x - startX) / trackW) * 100))
        if (Math.abs(newVal - scale.get_value()) >= 0.5) scale.set_value(newVal)
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    box.append(new Gtk.Image({ icon_name: iconNameLow,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(scale)
    box.append(new Gtk.Image({ icon_name: iconNameHigh, pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER }))
    box.append(valueLabel)

    let ignoreUntil = 0
    let pendingOnChange = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        ignoreUntil = GLib.get_monotonic_time() + 300_000
        if (!pendingOnChange) {
            pendingOnChange = true
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                onChange(scale.get_value() / 100)
                pendingOnChange = false
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const cleanup = onExternalChange((v) => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
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
    scale.set_increments(1, 5)
    scale.connect("change-value", (_s: Gtk.Scale, t: Gtk.ScrollType) =>
        t !== Gtk.ScrollType.STEP_UP && t !== Gtk.ScrollType.STEP_DOWN &&
        t !== Gtk.ScrollType.STEP_FORWARD && t !== Gtk.ScrollType.STEP_BACKWARD)

    const click = new Gtk.GestureClick({ propagation_phase: Gtk.PropagationPhase.CAPTURE, button: 1 })
    const motion = new Gtk.EventControllerMotion({ propagation_phase: Gtk.PropagationPhase.CAPTURE })
    scale.add_controller(click)
    scale.add_controller(motion)
    let isDragging = false, dragStart = 0, startY = 0, trackH = 1
    click.connect("pressed", (_g: Gtk.GestureClick, _n: number, _x: number, y: number) => {
        _g.set_state(Gtk.EventSequenceState.CLAIMED)
        isDragging = true
        dragStart = scale.get_value()
        startY = y
        trackH = Math.max(20, scale.get_height() - 20)
    })
    click.connect("released", () => { isDragging = false })
    motion.connect("motion", (_g: Gtk.EventControllerMotion, _x: number, y: number) => {
        if (!isDragging) return
        const newVal = Math.max(0, Math.min(100, dragStart + ((startY - y) / trackH) * 100))
        if (Math.abs(newVal - scale.get_value()) >= 0.5) scale.set_value(newVal)
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        halign: Gtk.Align.CENTER,
        width_chars: 5,
    })

    box.append(icon)
    box.append(scale)
    box.append(valueLabel)

    let ignoreUntil = 0
    let pendingOnChange = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        valueLabel.label = `${Math.round(v)}%`
        ignoreUntil = GLib.get_monotonic_time() + 300_000
        if (!pendingOnChange) {
            pendingOnChange = true
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                onChange(scale.get_value() / 100)
                pendingOnChange = false
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const cleanup = onExternalChange((v) => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
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
