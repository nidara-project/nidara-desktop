import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { listGroup, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function AudioPage() {
    const audio = AstalWp.get_default()?.audio
    if (!audio) return new Gtk.Label({ label: t("settings.audio.label.servicio-de-audio-no-disponible") })

    const page = pageBox("audio-page")
    page.append(pageHeader(t("settings.audio.page.title.sonido"), t("settings.audio.page.subtitle.administra-tus-dispositivos-de-entrada-y")))

    const speakerGroup = listGroup(t("settings.audio.group.dispositivos-de-salida"))
    const micGroup = listGroup(t("settings.audio.group.entrada-microfonos"))

    const createDeviceRow = (endpoint: any, isMic: boolean) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })

        // Header: Icon + Name + Mute
        const header = new Gtk.Box({ spacing: 12 })
        header.append(new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-speakers-symbolic",
            pixel_size: 18,
        }))
        header.append(new Gtk.Label({
            label: endpoint.description || endpoint.name || t("settings.audio.label.dispositivo"),
            halign: Gtk.Align.START,
            css_classes: ["settings-row-label"],
            hexpand: true,
            ellipsize: 3,
            max_width_chars: 30,
        }))

        const muteBtn = new Gtk.Button({
            icon_name: endpoint.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic",
            css_classes: ["settings-icon-btn", ...(endpoint.mute ? ["muted"] : [])],
            valign: Gtk.Align.CENTER,
        })
        muteBtn.connect("clicked", () => { endpoint.mute = !endpoint.mute })
        endpoint.connect("notify::mute", () => {
            muteBtn.icon_name = endpoint.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"
            if (endpoint.mute) muteBtn.add_css_class("muted")
            else muteBtn.remove_css_class("muted")
        })
        header.append(muteBtn)
        box.append(header)

        // Slider
        const sliderBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
        sliderBox.append(new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-volume-low-symbolic",
            pixel_size: 16,
            opacity: 0.5,
        }))

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            draw_value: false,
            css_classes: ["crystal-scale", "cc-atomic-scale-native"],
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100,
                step_increment: 2, page_increment: 10,
                value: endpoint.volume * 100,
            }),
        })

        sliderBox.append(scale)
        sliderBox.append(new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-volume-high-symbolic",
            pixel_size: 16,
            opacity: 0.5,
        }))

        const valueLabel = new Gtk.Label({
            label: `${Math.round(endpoint.volume * 100)}%`,
            css_classes: ["slider-value-label"],
            width_chars: 5,
            xalign: 1.0,
        })

        scale.connect("value-changed", () => {
            const val = scale.get_value()
            valueLabel.label = `${Math.round(val)}%`
            endpoint.volume = val / 100
        })
        endpoint.connect("notify::volume", () => {
            const val = Math.round(endpoint.volume * 100)
            if (Math.abs(scale.get_value() - val) > 1) {
                scale.set_value(val)
                valueLabel.label = `${val}%`
            }
        })

        sliderBox.append(valueLabel)
        box.append(sliderBox)

        const lbr = new Gtk.ListBoxRow({ css_classes: ["audio-device-row"] })
        lbr.set_child(box)
        return lbr
    }

    const refreshDevices = () => {
        [speakerGroup, micGroup].forEach(g => {
            let child = g.listBox.get_first_child()
            while (child) { g.listBox.remove(child); child = g.listBox.get_first_child() }
        })
        const speakers = audio.get_speakers ? audio.get_speakers() : []
        const microphones = audio.get_microphones ? audio.get_microphones() : []
        speakers.forEach((ep: any) => speakerGroup.listBox.append(createDeviceRow(ep, false)))
        microphones.forEach((ep: any) => micGroup.listBox.append(createDeviceRow(ep, true)))
    }

    const audioSignals = [
        audio.connect("speaker-added", refreshDevices),
        audio.connect("speaker-removed", refreshDevices),
        audio.connect("microphone-added", refreshDevices),
        audio.connect("microphone-removed", refreshDevices),
        audio.connect("notify::default-speaker", refreshDevices),
        audio.connect("notify::default-microphone", refreshDevices),
    ]
    refreshDevices()

    page.connect("unrealize", () => {
        audioSignals.forEach(id => { try { audio.disconnect(id) } catch {} })
    })

    page.append(speakerGroup.box)
    page.append(micGroup.box)

    return page
}
