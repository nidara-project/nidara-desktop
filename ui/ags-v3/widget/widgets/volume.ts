import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { VolumeWidget } from "../control-center/Sliders"
import { AtomicWidget, WidgetSize } from "../control-center/Types"

function buildBarContent(): Gtk.Widget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getIcon = () => {
        if (!speaker) return "audio-volume-muted-symbolic"
        const muted = (speaker as any).mute ?? false
        const vol = speaker.volume
        if (muted || vol === 0) return "audio-volume-muted-symbolic"
        if (vol < 0.34)         return "audio-volume-low-symbolic"
        if (vol < 0.67)         return "audio-volume-medium-symbolic"
        return "audio-volume-high-symbolic"
    }

    const image = new Gtk.Image({ icon_name: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16 })

    // Keep icon in sync
    if (speaker) {
        const ids = [
            speaker.connect("notify::volume", () => { image.icon_name = getIcon() }),
            (speaker as any).connect?.("notify::mute", () => { image.icon_name = getIcon() }) ?? 0,
        ]
        image.connect("unrealize", () => ids.forEach(id => { if (id) try { speaker.disconnect(id) } catch {} }))
    }

    // ── Popover content ──────────────────────────────────────────
    const volLabel = new Gtk.Label({
        label: speaker ? `${Math.round(speaker.volume * 100)}%` : "–",
        css_classes: ["bar-popover-value"],
        halign: Gtk.Align.CENTER,
    })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        draw_value: false,
        hexpand: true,
        width_request: 200,
        css_classes: ["crystal-scale"],
    })
    scale.set_range(0, 100)
    scale.set_value(speaker ? Math.round(speaker.volume * 100) : 50)
    scale.set_increments(2, 10)

    let ignoreExternal = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        volLabel.label = `${Math.round(v)}%`
        ignoreExternal = true
        if (speaker) speaker.volume = v / 100
        ignoreExternal = false
    })

    if (speaker) {
        const id = speaker.connect("notify::volume", () => {
            if (ignoreExternal) return
            const v = Math.round(speaker.volume * 100)
            if (Math.abs(scale.get_value() - v) > 1) {
                scale.set_value(v)
                volLabel.label = `${v}%`
            }
        })
        scale.connect("unrealize", () => { try { speaker.disconnect(id) } catch {} })
    }

    const muteBtn = new Gtk.Button({
        icon_name: (speaker as any)?.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic",
        css_classes: ["bar-popover-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => {
        if (speaker) (speaker as any).mute = !((speaker as any).mute ?? false)
        muteBtn.icon_name = (speaker as any)?.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"
    })

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(muteBtn)
    row.append(scale)
    row.append(volLabel)

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 14,
        margin_end: 14,
    })
    popBox.append(new Gtk.Label({ label: "Volumen", css_classes: ["bar-popover-title"], halign: Gtk.Align.START }))
    popBox.append(row)

    const popover = new Gtk.Popover({ autohide: true, position: Gtk.PositionType.BOTTOM })
    popover.set_child(popBox)
    popover.set_parent(image)
    image.connect("unrealize", () => { try { popover.unparent() } catch {} })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

const volumeWidget: AtomicWidget = {
    id: "volume",
    name: "Volumen",
    icon: "audio-volume-high-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],
    buildContent: (size) => VolumeWidget().buildContent(size),
    buildBarContent,
}

export default volumeWidget
