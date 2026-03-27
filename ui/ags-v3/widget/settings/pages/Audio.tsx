import { Astal, Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import PillSlider from "../../common/PillSlider"

/**
 * Audio Settings Page 🔊 - Crystal V3 (macOS Tahoe Inspired)
 */
export default function AudioPage() {
    const audio = AstalWp.get_default()?.audio
    if (!audio) return new Gtk.Label({ label: "Servicio de Audio no disponible" })

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["settings-page", "audio-page"],
        margin_start: 12,
        margin_end: 12,
        margin_top: 40,
        margin_bottom: 40,
    })

    // Header Section (Tahoe Style)
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_bottom: 24,
        margin_start: 6
    })
    
    headerBox.append(new Gtk.Label({
        label: "Sonido",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    
    headerBox.append(new Gtk.Label({
        label: "Administra tus dispositivos de entrada y salida",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    
    page.append(headerBox)

    // ── Helper: Boxed List Group ──
    const listGroup = (title: string) => {
        const box = new Gtk.Box({ 
            orientation: Gtk.Orientation.VERTICAL, 
            spacing: 12,
            css_classes: ["settings-group"] 
        })
        
        if (title) {
            box.append(new Gtk.Label({
                label: title.toUpperCase(),
                css_classes: ["settings-group-title"],
                halign: Gtk.Align.START,
                margin_start: 10
            }))
        }
        
        const listBox = new Gtk.ListBox({
            css_classes: ["settings-list-box", "boxed-list"],
            selection_mode: Gtk.SelectionMode.NONE
        })
        
        box.append(listBox)
        return { box, listBox }
    }

    const speakerGroup = listGroup("Dispositivos de Salida")
    const micGroup = listGroup("Entrada (Micrófonos)")

    const refreshDevices = () => {
        [speakerGroup, micGroup].forEach(g => {
            let child = g.listBox.get_first_child()
            while (child) {
                g.listBox.remove(child)
                child = g.listBox.get_first_child()
            }
        })

        const speakers = audio.get_speakers ? audio.get_speakers() : []
        const microphones = audio.get_microphones ? audio.get_microphones() : []

        speakers.forEach(endpoint => {
            speakerGroup.listBox.append(createDeviceRow(endpoint, false))
        })

        microphones.forEach(endpoint => {
            micGroup.listBox.append(createDeviceRow(endpoint, true))
        })
    }

    const createDeviceRow = (endpoint: any, isMic: boolean) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })

        const header = new Gtk.Box({ spacing: 12 })
        header.append(new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-speakers-symbolic",
            pixel_size: 18
        }))
        
        const nameLabel = new Gtk.Label({
            label: endpoint.description || endpoint.name || "Dispositivo",
            halign: Gtk.Align.START,
            css_classes: ["settings-row-label"],
            hexpand: true
        })
        header.append(nameLabel)

        const muteBtn = new Gtk.Button({
            icon_name: endpoint.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic",
            css_classes: ["settings-icon-btn", endpoint.mute ? "muted" : ""],
            valign: Gtk.Align.CENTER
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
        box.append(header)

        const slider = PillSlider({
            iconName: isMic ? "audio-input-microphone-symbolic" : "audio-volume-high-symbolic",
            value: endpoint.volume,
            onChanged: (v) => { endpoint.volume = v }
        })
        box.append(slider)

        return new Gtk.ListBoxRow({ child: box, css_classes: ["audio-device-row"] })
    }

    audio.connect("speaker-added", refreshDevices)
    audio.connect("speaker-removed", refreshDevices)
    audio.connect("microphone-added", refreshDevices)
    audio.connect("microphone-removed", refreshDevices)
    audio.connect("notify::default-speaker", refreshDevices)
    audio.connect("notify::default-microphone", refreshDevices)
    refreshDevices()

    page.append(speakerGroup.box)
    page.append(micGroup.box)

    return page
}
