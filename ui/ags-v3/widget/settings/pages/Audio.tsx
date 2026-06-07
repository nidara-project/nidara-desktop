import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { execAsync } from "ags/process"
import { listGroup, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { CrystalButton } from "../../../../lib/crystal-ui"
import { makeHSlider } from "../../common/Slider"

// ── Helpers ───────────────────────────────────────────────────────────────────

function setDefault(endpoint: any, isMic: boolean) {
    // wpctl set-default is the most reliable path across PipeWire versions
    execAsync(["wpctl", "set-default", String(endpoint.id)])
        .catch(e => console.error("[Audio] set-default failed:", e))
}

// Volume-level icon (used for the mute button) — same gradient for inputs and
// outputs; a muted mic reads better as volume-muted than a plain mic glyph.
function volumeIcon(vol: number, muted: boolean) {
    if (muted || vol === 0) return Icons.volumeMuted
    if (vol < 0.34) return Icons.volumeLow
    if (vol < 0.67) return Icons.volumeMedium
    return Icons.volumeHigh
}

// Cairo volume slider (makeHSlider) — fill + thumb are drawn together so they never
// separate like the native Gtk.Scale highlight/slider, and its sync guards stop the
// WirePlumber volume feedback from fighting the drag. `target` has a 0–1 `volume`.
function volumeSlider(target: any, valLabel: Gtk.Label, refreshMute: () => void): Gtk.Widget {
    return makeHSlider({
        min: 0, max: 100,
        value: Math.round((target.volume ?? 0) * 100),
        onChange: (v) => { target.volume = v / 100 },
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => {
            const id = target.connect("notify::volume", () => { cb((target.volume ?? 0) * 100); refreshMute() })
            return () => { try { target.disconnect(id) } catch {} }
        },
        debounce: 24,
        cssClasses: ["cc-atomic-scale-native"],
    })
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
        label: endpoint.description || endpoint.name || t("settings.audio.device"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["crystal-row-title"],
        ellipsize: 3, max_width_chars: 26,
    }))

    // Default badge / set-default button
    if (isDefault) {
        header.append(new Gtk.Label({
            label: t("settings.audio.default"),
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
        gicon: volumeIcon(endpoint.volume, endpoint.mute ?? false),
        pixel_size: 18, css_classes: ["cs-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { endpoint.mute = !endpoint.mute })
    endpoint.connect("notify::mute", () => {
        muteImg.gicon = volumeIcon(endpoint.volume, endpoint.mute ?? false)
    })
    header.append(muteBtn)
    box.append(header)

    // ── Volume slider ─────────────────────────────────────────────────────────
    const valLabel = new Gtk.Label({
        label: `${Math.round(endpoint.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })
    const scale = volumeSlider(endpoint, valLabel, () => {
        muteImg.gicon = volumeIcon(endpoint.volume, endpoint.mute ?? false)
    })

    const sliderRow = new Gtk.Box({ spacing: 8 })
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(scale)
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(valLabel)
    box.append(sliderRow)

    const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
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

    // Same vertical layout as the device rows: header (icon + name + mute) on top,
    // slider underneath.
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_start: 16, margin_end: 16,
        margin_top: 14, margin_bottom: 14,
    })

    // ── Header ────────────────────────────────────────────────────────────────
    const header = new Gtk.Box({ spacing: 10 })
    // Real app icon — NO cs-icon: that class recolours/inverts monochrome UI glyphs,
    // which mangles a full-colour app icon. Sized to match the device leading icon.
    header.append(new Gtk.Image({ icon_name: iconName, pixel_size: 24, valign: Gtk.Align.CENTER }))
    header.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["crystal-row-title"],
        ellipsize: 3, max_width_chars: 26,
    }))

    const muteImg = new Gtk.Image({
        gicon: volumeIcon(stream.volume, stream.mute ?? false),
        pixel_size: 18, css_classes: ["cs-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { stream.mute = !stream.mute })
    stream.connect("notify::mute", () => {
        muteImg.gicon = volumeIcon(stream.volume, stream.mute ?? false)
    })
    header.append(muteBtn)
    box.append(header)

    // ── Volume slider ─────────────────────────────────────────────────────────
    const valLabel = new Gtk.Label({
        label: `${Math.round(stream.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })
    const scale = volumeSlider(stream, valLabel, () => {
        muteImg.gicon = volumeIcon(stream.volume, stream.mute ?? false)
    })

    const sliderRow = new Gtk.Box({ spacing: 8 })
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(scale)
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    sliderRow.append(valLabel)
    box.append(sliderRow)

    const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
    row.set_child(box)
    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
    const wp    = AstalWp.get_default()
    const audio = wp?.audio
    if (!audio) return new Gtk.Label({ label: t("settings.audio.error.no-service") })

    const page = pageBox("audio-page")
    page.append(pageHeader(
        t("settings.audio.title"),
        t("settings.audio.subtitle")
    ))

    const speakerGroup = listGroup(t("settings.audio.group.output"))
    const micGroup     = listGroup(t("settings.audio.group.input"))
    const streamGroup  = listGroup(t("settings.audio.group.apps"))

    const emptyStreams = new Gtk.Label({
        label: t("settings.audio.no-apps"),
        css_classes: ["crystal-row-subtitle"],
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
