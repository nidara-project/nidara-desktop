import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { makeHSlider } from "../common/Slider"
import { VolumeWidget } from "../control-center/Sliders"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

function buildBarContent(): Gtk.Widget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getIcon = () => {
        if (!speaker) return Icons.volumeMuted
        const muted = (speaker as any).mute ?? false
        const vol = speaker.volume
        if (muted || vol === 0) return Icons.volumeMuted
        if (vol < 0.34)         return Icons.volumeLow
        if (vol < 0.67)         return Icons.volumeMedium
        return Icons.volumeHigh
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
        width_chars: 5, xalign: 1.0,
    })

    const sliderWidget = makeHSlider({
        value: speaker ? Math.round(speaker.volume * 100) : 50,
        onChange: (v) => { if (speaker) speaker.volume = v / 100 },
        onValueChanged: (v) => { volLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => {
            if (!speaker) return () => {}
            const id = speaker.connect("notify::volume", () => cb(Math.round(speaker.volume * 100)))
            return () => { try { speaker.disconnect(id) } catch {} }
        },
        width_request: 200,
    })

    const muteBtn = new Gtk.Button({
        icon_name: (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh,
        css_classes: ["bar-popover-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => {
        if (speaker) (speaker as any).mute = !((speaker as any).mute ?? false)
        muteBtn.icon_name = (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh
    })

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(muteBtn)
    row.append(sliderWidget)
    row.append(volLabel)

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 14,
        margin_end: 14,
    })
    popBox.append(new Gtk.Label({ label: t("cc.volume.name"), css_classes: ["bar-popover-title"], halign: Gtk.Align.START }))
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
    name: t("cc.volume.name"),
    icon: Icons.volumeHigh,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],
    buildContent: (size) => VolumeWidget().buildContent(size),
    buildBarContent,
}

export default volumeWidget
