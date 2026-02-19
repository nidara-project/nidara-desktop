import { Astal, Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import PillSlider from "../../common/PillSlider"

/**
 * Audio Settings Page 🔊
 */
export default function AudioPage() {
    const audio = AstalWp.get_default()?.audio
    if (!audio) return new Gtk.Label({ label: "Servicio de Audio no disponible" })

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page"],
        margin_start: 40,
        margin_end: 40,
        margin_top: 40
    })

    const title = new Gtk.Label({
        label: "Sonido",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START
    })

    page.append(title)
    page.append(new Gtk.Separator())

    // Speakers Section
    const speakerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12
    })

    speakerBox.append(new Gtk.Label({
        label: "Dispositivos de Entrada/Salida",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START
    }))

    const speakerList = new Gtk.ListBox({
        css_classes: ["settings-list"],
        selection_mode: Gtk.SelectionMode.NONE
    })

    const refreshSpeakers = () => {
        // Clear children
        let child = speakerList.get_first_child()
        while (child) {
            speakerList.remove(child)
            child = speakerList.get_first_child()
        }

        const endpoints = [
            ...(audio.get_speakers ? audio.get_speakers() : []),
            ...(audio.get_microphones ? audio.get_microphones() : [])
        ]

        endpoints.forEach(endpoint => {
            const isMic = (endpoint.description || "").toLowerCase().includes("mic")

            const rowContent = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_start: 16,
                margin_end: 16,
                margin_top: 16,
                margin_bottom: 16,
                halign: Gtk.Align.FILL
            })

            const header = new Gtk.Box({ spacing: 12 })
            header.append(new Gtk.Image({
                icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-speakers-symbolic",
                pixel_size: 20
            }))
            header.append(new Gtk.Label({
                label: endpoint.description || endpoint.name || "Endpoint",
                halign: Gtk.Align.START,
                css_classes: ["endpoint-name"],
                hexpand: true
            }))

            const muteBtn = new Gtk.Button({
                icon_name: endpoint.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic",
                css_classes: ["settings-icon-btn", endpoint.mute ? "muted" : ""]
            })

            muteBtn.connect("clicked", () => {
                endpoint.mute = !endpoint.mute
            })

            endpoint.connect("notify::mute", () => {
                muteBtn.icon_name = endpoint.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"
                if (endpoint.mute) muteBtn.add_css_class("muted")
                else muteBtn.remove_css_class("muted")
            })

            header.append(muteBtn)
            rowContent.append(header)

            const slider = PillSlider({
                iconName: isMic ? "audio-input-microphone-symbolic" : "audio-volume-high-symbolic",
                value: endpoint.volume,
                onChanged: (v) => { endpoint.volume = v }
            })

            rowContent.append(slider)
            speakerList.append(new Gtk.ListBoxRow({ child: rowContent }))
        })
    }

    speakerBox.append(speakerList)
    page.append(speakerBox)

    // Initial sync
    refreshSpeakers()
    audio.connect("notify::speakers", refreshSpeakers)
    audio.connect("notify::microphones", refreshSpeakers)

    return page
}
