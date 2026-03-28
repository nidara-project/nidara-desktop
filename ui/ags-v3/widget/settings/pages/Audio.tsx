import { Astal, Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"

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
            spacing: 12,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })

        // Top Row: Icon + Name + Mute
        const header = new Gtk.Box({ spacing: 12 })
        header.append(new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-speakers-symbolic",
            pixel_size: 18
        }))
        
        const nameLabel = new Gtk.Label({
            label: endpoint.description || endpoint.name || "Dispositivo",
            halign: Gtk.Align.START,
            css_classes: ["settings-row-label"],
            hexpand: true,
            ellipsize: 3,
            max_width_chars: 30
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

        // Bottom Row: Scale + Side Icons + Value
        const sliderBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER
        })

        const lowIcon = new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-volume-low-symbolic",
            pixel_size: 16,
            opacity: 0.5
        })

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            draw_value: false,
            css_classes: ["crystal-scale", "cc-atomic-scale-native"],
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 2,
                page_increment: 10,
                value: endpoint.volume * 100
            })
        })

        const highIcon = new Gtk.Image({
            icon_name: isMic ? "audio-input-microphone-symbolic" : "audio-volume-high-symbolic",
            pixel_size: 16,
            opacity: 0.5
        })

        const valueLabel = new Gtk.Label({
            label: `${Math.round(endpoint.volume * 100)}%`,
            css_classes: ["slider-value-label"],
            width_chars: 4
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

        sliderBox.append(lowIcon)
        sliderBox.append(scale)
        sliderBox.append(highIcon)
        sliderBox.append(valueLabel)
        
        box.append(sliderBox)

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
