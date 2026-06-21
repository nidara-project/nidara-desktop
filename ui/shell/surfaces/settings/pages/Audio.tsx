import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { listGroup, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import * as AudioSvc from "../../../core/AudioService"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { makeVolumeSlider } from "../../../common/Slider"

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
        pixel_size: 18, css_classes: ["nd-icon"],
    }))
    header.append(new Gtk.Label({
        label: endpoint.description || endpoint.name || t("settings.audio.device"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"],
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
        const setBtn = NidaraButton({
            label: t("settings.audio.btn.set-default"),
            variant: "ghost",
            valign: Gtk.Align.CENTER,
        })
        setBtn.connect("clicked", onSetDefault)
        header.append(setBtn)
    }

    // Mute button
    const muteImg = new Gtk.Image({
        gicon: AudioSvc.targetVolumeIcon(endpoint),
        pixel_size: 18, css_classes: ["nd-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(endpoint) })
    endpoint.connect("notify::mute", () => {
        muteImg.gicon = AudioSvc.targetVolumeIcon(endpoint)
    })
    header.append(muteBtn)
    box.append(header)

    // ── Volume slider ─────────────────────────────────────────────────────────
    const valLabel = new Gtk.Label({
        label: `${Math.round(endpoint.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })
    const scale = makeVolumeSlider(endpoint, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(endpoint) },
        cssClasses: ["cc-atomic-scale-native"],
    })

    const sliderRow = new Gtk.Box({ spacing: 8 })
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    sliderRow.append(scale)
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    sliderRow.append(valLabel)
    box.append(sliderRow)

    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
    row.set_child(box)
    return row
}

// ── Stream row (per-app) ──────────────────────────────────────────────────────

function createStreamRow(stream: any): Gtk.ListBoxRow {
    const appName = stream.description || stream.name || "App"
    const iconName = AudioSvc.streamIconName(stream)

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
    // Real app icon — NO nd-icon: that class recolours/inverts monochrome UI glyphs,
    // which mangles a full-colour app icon. Sized to match the device leading icon.
    header.append(new Gtk.Image({ icon_name: iconName, pixel_size: 24, valign: Gtk.Align.CENTER }))
    header.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"],
        ellipsize: 3, max_width_chars: 26,
    }))

    const muteImg = new Gtk.Image({
        gicon: AudioSvc.targetVolumeIcon(stream),
        pixel_size: 18, css_classes: ["nd-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(stream) })
    stream.connect("notify::mute", () => {
        muteImg.gicon = AudioSvc.targetVolumeIcon(stream)
    })
    header.append(muteBtn)
    box.append(header)

    // ── Volume slider ─────────────────────────────────────────────────────────
    const valLabel = new Gtk.Label({
        label: `${Math.round(stream.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })
    const scale = makeVolumeSlider(stream, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(stream) },
        cssClasses: ["cc-atomic-scale-native"],
    })

    const sliderRow = new Gtk.Box({ spacing: 8 })
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    sliderRow.append(scale)
    sliderRow.append(new Gtk.Image({ gicon: Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    sliderRow.append(valLabel)
    box.append(sliderRow)

    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
    row.set_child(box)
    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
    const wp    = AstalWp.get_default()
    const audio = wp?.audio
    if (!audio) return new Gtk.Label({ label: t("settings.audio.error.no-service") })

    const page = pageBox("audio-page")

    // Settings caches every page for the window's lifetime, so audio-hardware
    // presence can't be a build-time check — a USB DAC/headset may appear later (or
    // PipeWire may expose no devices at all, as in a VM). Show a placeholder when
    // there are neither outputs nor inputs, mirroring the Bluetooth/Network pages;
    // applyHardware() (wired into the device watch) switches it live.
    const banner = new Gtk.Label({
        label: t("settings.audio.error.no-hardware"),
        css_classes: ["settings-placeholder"],
        margin_top: 24,
        halign: Gtk.Align.CENTER,
    })
    page.append(banner)

    const speakerGroup = listGroup(t("settings.audio.group.output"))
    const micGroup     = listGroup(t("settings.audio.group.input"))
    const streamGroup  = listGroup(t("settings.audio.group.apps"))

    const emptyStreams = new Gtk.Label({
        label: t("settings.audio.no-apps"),
        css_classes: ["nidara-row-subtitle"],
        margin_top: 12, margin_bottom: 12, margin_start: 16,
        halign: Gtk.Align.START,
    })

    // ── Devices ───────────────────────────────────────────────────────────────
    const refreshDevices = () => {
        [speakerGroup, micGroup].forEach(g => {
            let c = g.listBox.get_first_child()
            while (c) { g.listBox.remove(c); c = g.listBox.get_first_child() }
        })

        const defaultSpk = AudioSvc.defaultSpeaker(audio)
        const defaultMic = AudioSvc.defaultMicrophone(audio)

        AudioSvc.speakers(audio).forEach(ep => {
            const isDef = defaultSpk && ep.id === defaultSpk.id
            speakerGroup.listBox.append(createDeviceRow(ep, false, isDef, () => AudioSvc.setDefault(ep)))
        })
        AudioSvc.microphones(audio).forEach(ep => {
            const isDef = defaultMic && ep.id === defaultMic.id
            micGroup.listBox.append(createDeviceRow(ep, true, isDef, () => AudioSvc.setDefault(ep)))
        })

        // No outputs and no inputs = no sound hardware → show the placeholder and
        // hide the (empty) device/app groups, instead of three bare headers.
        const hasHardware = AudioSvc.speakers(audio).length > 0 || AudioSvc.microphones(audio).length > 0
        banner.visible = !hasHardware
        speakerGroup.box.visible = hasHardware
        micGroup.box.visible = hasHardware
        streamGroup.box.visible = hasHardware
    }

    // ── Streams ───────────────────────────────────────────────────────────────
    const refreshStreams = () => {
        let c = streamGroup.listBox.get_first_child()
        while (c) { streamGroup.listBox.remove(c); c = streamGroup.listBox.get_first_child() }

        const streams = AudioSvc.streams(audio)
        emptyStreams.visible = streams.length === 0
        streams.forEach(s => streamGroup.listBox.append(createStreamRow(s)))
    }

    // ── Signals ───────────────────────────────────────────────────────────────
    const disposeDevices = AudioSvc.watchDevices(refreshDevices, audio)
    const disposeStreams = AudioSvc.watchStreams(refreshStreams, audio)

    refreshDevices()
    refreshStreams()

    page.connect("unrealize", () => { disposeDevices(); disposeStreams() })

    streamGroup.listBox.append(emptyStreams)
    page.append(speakerGroup.box)
    page.append(micGroup.box)
    page.append(streamGroup.box)

    return page
}
