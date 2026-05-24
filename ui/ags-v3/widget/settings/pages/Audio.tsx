import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { execAsync } from "ags/process"
import { listGroup, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { CrystalButton } from "../../../../lib/crystal-ui"

// ── Helpers ───────────────────────────────────────────────────────────────────

function setDefault(endpoint: any, isMic: boolean) {
    // wpctl set-default is the most reliable path across PipeWire versions
    execAsync(["wpctl", "set-default", String(endpoint.id)])
        .catch(e => console.error("[Audio] set-default failed:", e))
}

function volumeIcon(isMic: boolean, vol: number, muted: boolean) {
    if (isMic) return Icons.mic
    if (muted || vol === 0) return Icons.volumeMuted
    if (vol < 0.34) return Icons.volumeLow
    if (vol < 0.67) return Icons.volumeMedium
    return Icons.volumeHigh
}

// ── Device row (speakers / mics) ──────────────────────────────────────────────

function createDeviceRow(
    endpoint: any,
    isMic: boolean,
    isDefault: boolean,
    onSetDefault: () => void,
): Gtk.ListBoxRow {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_start: 16, margin_end: 16,
        margin_top: 14, margin_bottom: 14,
    })

    // ── Header ────────────────────────────────────────────────────────────────
    const header = new Gtk.Box({ spacing: 10 })

    header.append(new Gtk.Image({
        gicon: isMic ? Icons.mic : Icons.speaker,
        pixel_size: 18, css_classes: ["cs-icon"],
    }))
    header.append(new Gtk.Label({
        label: endpoint.description || endpoint.name || t("settings.audio.label.dispositivo"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["settings-row-label"],
        ellipsize: 3, max_width_chars: 26,
    }))

    // Default badge / set-default button
    if (isDefault) {
        header.append(new Gtk.Label({
            label: t("settings.audio.label.por-defecto"),
            css_classes: ["settings-row-status", "accent-label"],
            valign: Gtk.Align.CENTER,
        }))
    } else {
        const setBtn = CrystalButton({
            label: t("settings.audio.btn.set-default"),
            variant: "ghost",
            valign: Gtk.Align.CENTER,
        })
        setBtn.connect("clicked", onSetDefault)
        header.append(setBtn)
    }

    // Mute button
    const muteImg = new Gtk.Image({
        gicon: volumeIcon(isMic, endpoint.volume, endpoint.mute ?? false),
        pixel_size: 18, css_classes: ["cs-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { endpoint.mute = !endpoint.mute })
    endpoint.connect("notify::mute", () => {
        muteImg.gicon = volumeIcon(isMic, endpoint.volume, endpoint.mute ?? false)
    })
    header.append(muteBtn)
    box.append(header)

    // ── Volume slider ─────────────────────────────────────────────────────────
    const adj = new Gtk.Adjustment({
        lower: 0, upper: 100,
        step_increment: 2, page_increment: 10,
        value: Math.round(endpoint.volume * 100),
    })
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL, hexpand: true,
        draw_value: false, adjustment: adj,
        css_classes: ["crystal-scale", "cc-atomic-scale-native"],
    })
    const valLabel = new Gtk.Label({
        label: `${Math.round(endpoint.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })

    scale.connect("value-changed", () => {
        const v = scale.get_value()
        endpoint.volume = v / 100
        valLabel.label = `${Math.round(v)}%`
    })
    endpoint.connect("notify::volume", () => {
        const v = Math.round(endpoint.volume * 100)
        if (Math.abs(scale.get_value() - v) >= 1) {
            scale.set_value(v)
            valLabel.label = `${v}%`
        }
        muteImg.gicon = volumeIcon(isMic, endpoint.volume, endpoint.mute ?? false)
    })

    const sliderRow = new Gtk.Box({ spacing: 8 })
    sliderRow.append(new Gtk.Image({ gicon: isMic ? Icons.mic : Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(scale)
    sliderRow.append(new Gtk.Image({ gicon: isMic ? Icons.mic : Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(valLabel)
    box.append(sliderRow)

    const row = new Gtk.ListBoxRow({ css_classes: ["audio-device-row"] })
    row.set_child(box)
    return row
}

// ── Stream row (per-app) ──────────────────────────────────────────────────────

function createStreamRow(stream: any): Gtk.ListBoxRow {
    const appName = stream.description || stream.name || "App"
    const rawIcon: string = stream.icon ?? ""
    const iconName = (rawIcon && rawIcon !== "audio-card-symbolic")
        ? rawIcon
        : (stream.name?.toLowerCase() ?? "audio-x-generic-symbolic")

    const box = new Gtk.Box({
        spacing: 12,
        margin_start: 16, margin_end: 16,
        margin_top: 12, margin_bottom: 12,
        valign: Gtk.Align.CENTER,
    })

    box.append(new Gtk.Image({ icon_name: iconName, pixel_size: 16, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
    box.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START,
        css_classes: ["settings-row-label"],
        ellipsize: 3, max_width_chars: 18,
        width_chars: 14,
    }))

    // Mute
    const muteImg = new Gtk.Image({
        gicon: volumeIcon(false, stream.volume, stream.mute ?? false),
        pixel_size: 16, css_classes: ["cs-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn", "flat"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { stream.mute = !stream.mute })
    stream.connect("notify::mute", () => {
        muteImg.gicon = volumeIcon(false, stream.volume, stream.mute ?? false)
    })

    // Slider
    const adj = new Gtk.Adjustment({
        lower: 0, upper: 100,
        step_increment: 2, page_increment: 10,
        value: Math.round(stream.volume * 100),
    })
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL, hexpand: true,
        draw_value: false, adjustment: adj,
        css_classes: ["crystal-scale", "cc-atomic-scale-native"],
    })
    const valLabel = new Gtk.Label({
        label: `${Math.round(stream.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })

    scale.connect("value-changed", () => {
        const v = scale.get_value()
        stream.volume = v / 100
        valLabel.label = `${Math.round(v)}%`
    })
    stream.connect("notify::volume", () => {
        const v = Math.round(stream.volume * 100)
        if (Math.abs(scale.get_value() - v) >= 1) {
            scale.set_value(v)
            valLabel.label = `${v}%`
        }
        muteImg.gicon = volumeIcon(false, stream.volume, stream.mute ?? false)
    })

    box.append(muteBtn)
    box.append(scale)
    box.append(valLabel)

    const row = new Gtk.ListBoxRow({ css_classes: ["audio-device-row"] })
    row.set_child(box)
    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
    const wp    = AstalWp.get_default()
    const audio = wp?.audio
    if (!audio) return new Gtk.Label({ label: t("settings.audio.label.servicio-de-audio-no-disponible") })

    const page = pageBox("audio-page")
    page.append(pageHeader(
        t("settings.audio.page.title.sonido"),
        t("settings.audio.page.subtitle.administra-tus-dispositivos-de-entrada-y")
    ))

    const speakerGroup = listGroup(t("settings.audio.group.dispositivos-de-salida"))
    const micGroup     = listGroup(t("settings.audio.group.entrada-microfonos"))
    const streamGroup  = listGroup(t("settings.audio.group.aplicaciones"))

    const emptyStreams = new Gtk.Label({
        label: t("settings.audio.label.sin-apps"),
        css_classes: ["settings-row-subtitle"],
        margin_top: 12, margin_bottom: 12, margin_start: 16,
        halign: Gtk.Align.START,
    })

    // ── Devices ───────────────────────────────────────────────────────────────
    const refreshDevices = () => {
        [speakerGroup, micGroup].forEach(g => {
            let c = g.listBox.get_first_child()
            while (c) { g.listBox.remove(c); c = g.listBox.get_first_child() }
        })

        const defaultSpk = audio.default_speaker
        const defaultMic = audio.default_microphone

        const speakers: any[] = audio.get_speakers ? audio.get_speakers() : []
        const mics:     any[] = audio.get_microphones ? audio.get_microphones() : []

        speakers.forEach(ep => {
            const isDef = defaultSpk && ep.id === defaultSpk.id
            speakerGroup.listBox.append(createDeviceRow(ep, false, isDef, () => setDefault(ep, false)))
        })
        mics.forEach(ep => {
            const isDef = defaultMic && ep.id === defaultMic.id
            micGroup.listBox.append(createDeviceRow(ep, true, isDef, () => setDefault(ep, true)))
        })
    }

    // ── Streams ───────────────────────────────────────────────────────────────
    const refreshStreams = () => {
        let c = streamGroup.listBox.get_first_child()
        while (c) { streamGroup.listBox.remove(c); c = streamGroup.listBox.get_first_child() }

        const streams: any[] = audio.get_streams ? audio.get_streams() : []
        emptyStreams.visible = streams.length === 0
        streams.forEach(s => streamGroup.listBox.append(createStreamRow(s)))
    }

    // ── Signals ───────────────────────────────────────────────────────────────
    const sigs = [
        audio.connect("speaker-added",            refreshDevices),
        audio.connect("speaker-removed",          refreshDevices),
        audio.connect("microphone-added",         refreshDevices),
        audio.connect("microphone-removed",       refreshDevices),
        audio.connect("notify::default-speaker",  refreshDevices),
        audio.connect("notify::default-microphone", refreshDevices),
        audio.connect("stream-added",             refreshStreams),
        audio.connect("stream-removed",           refreshStreams),
    ]

    refreshDevices()
    refreshStreams()

    page.connect("unrealize", () => {
        sigs.forEach(id => { try { audio.disconnect(id) } catch {} })
    })

    streamGroup.listBox.append(emptyStreams)
    page.append(speakerGroup.box)
    page.append(micGroup.box)
    page.append(streamGroup.box)

    return page
}
