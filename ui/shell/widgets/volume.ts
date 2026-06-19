import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import AstalWp from "gi://AstalWp"
import { makeVolumeSlider } from "../common/Slider"
import { VolumeWidget } from "../surfaces/control-center/Sliders"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import * as AudioSvc from "../core/AudioService"

// ── Bar icon (dynamic, reflects mute/volume level) ────────────────────────────

function buildBarContent(): Gtk.Widget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker
    const getIcon = () => speaker ? AudioSvc.targetVolumeIcon(speaker) : Icons.volumeMuted

    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })

    if (speaker) {
        const dispose = AudioSvc.watchVolume(speaker, () => { image.gicon = getIcon() })
        image.connect("unrealize", dispose)
    }

    return image
}

// ── Bar expansion panel content ───────────────────────────────────────────────

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const volLabel = new Gtk.Label({
        label: speaker ? `${Math.round(speaker.volume * 100)}%` : "–",
        css_classes: ["bar-popover-value"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    const sliderWidget = makeVolumeSlider(speaker, {
        onValueChanged: (v) => { volLabel.label = `${Math.round(v)}%` },
        width_request: PANEL_W.sm,
    })

    const muteImg = new Gtk.Image({ gicon: (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh, pixel_size: 16, css_classes: ["nd-icon"] })
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["bar-popover-icon-btn"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => {
        if (speaker) (speaker as any).mute = !((speaker as any).mute ?? false)
        muteImg.gicon = (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh
    })

    if (speaker) {
        const id = (speaker as any).connect?.("notify::mute", () => {
            muteImg.gicon = (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh
        }) ?? 0
        muteBtn.connect("unrealize", () => { if (id) try { speaker.disconnect(id) } catch {} })
    }

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(muteBtn)
    row.append(sliderWidget)
    row.append(volLabel)

    return row
}

// ── CC detail: per-device output sliders + per-app stream sliders ─────────────

function buildSpeakerRow(ep: any, isDefault: boolean): Gtk.ListBoxRow {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })

    const header = new Gtk.Box({ spacing: 8 })
    header.append(new Gtk.Label({
        label: ep.description || ep.name || t("settings.audio.device"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"], ellipsize: 3, max_width_chars: 18,
    }))
    if (isDefault) {
        header.append(new Gtk.Label({
            label: t("settings.audio.default"),
            css_classes: ["settings-row-status", "accent-label"], valign: Gtk.Align.CENTER,
        }))
    } else {
        const setBtn = new Gtk.Button({ label: t("settings.audio.btn.set-default"), css_classes: ["flat", "compact-btn"], valign: Gtk.Align.CENTER })
        setBtn.connect("clicked", () => AudioSvc.setDefault(ep))
        header.append(setBtn)
    }
    const muteImg = new Gtk.Image({ gicon: AudioSvc.targetVolumeIcon(ep), pixel_size: 16, css_classes: ["nd-icon"] })
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["settings-icon-btn"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(ep) })
    ep.connect("notify::mute", () => { muteImg.gicon = AudioSvc.targetVolumeIcon(ep) })
    header.append(muteBtn)
    box.append(header)

    const valLabel = new Gtk.Label({ label: `${Math.round(ep.volume * 100)}%`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const scale = makeVolumeSlider(ep, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(ep) },
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

function buildStreamRow(stream: any): Gtk.ListBoxRow {
    const appName = stream.description || stream.name || "App"
    const iconName = AudioSvc.streamIconName(stream)

    const box = new Gtk.Box({ spacing: 10, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10, valign: Gtk.Align.CENTER })
    const muteImg = new Gtk.Image({ gicon: AudioSvc.targetVolumeIcon(stream), pixel_size: 16, css_classes: ["nd-icon"] })
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["settings-icon-btn", "flat"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(stream) })
    stream.connect("notify::mute", () => { muteImg.gicon = AudioSvc.targetVolumeIcon(stream) })
    box.append(new Gtk.Image({ icon_name: iconName, pixel_size: 16, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER }))
    box.append(muteBtn)
    box.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"], ellipsize: 3, max_width_chars: 16,
    }))
    const valLabel = new Gtk.Label({ label: `${Math.round(stream.volume * 100)}%`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const scale = makeVolumeSlider(stream, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(stream) },
    })
    box.append(scale)
    box.append(valLabel)
    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
    row.set_child(box)
    return row
}

function buildCCDetail(_onClose: () => void): Gtk.Widget {
    const audio = AstalWp.get_default()?.audio
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })

    if (!audio) {
        box.append(new Gtk.Label({
            label: t("settings.audio.error.no-service"),
            css_classes: ["nidara-row-subtitle"],
            margin_top: 12, margin_start: 14, halign: Gtk.Align.START,
        }))
        return box
    }

    const sectionLabel = (text: string) => new Gtk.Label({
        label: text, css_classes: ["cc-detail-section-label"],
        halign: Gtk.Align.START, margin_start: 14, margin_top: 4,
    })

    const speakersList = new Gtk.ListBox({ css_classes: ["nidara-list"], selection_mode: Gtk.SelectionMode.NONE })
    const streamsList  = new Gtk.ListBox({ css_classes: ["nidara-list"], selection_mode: Gtk.SelectionMode.NONE })
    const emptyStreams  = new Gtk.Label({
        label: t("settings.audio.no-apps"),
        css_classes: ["nidara-row-subtitle"],
        margin_top: 8, margin_bottom: 8, margin_start: 14, halign: Gtk.Align.START,
    })

    const refreshSpeakers = () => {
        let c = speakersList.get_first_child()
        while (c) { speakersList.remove(c); c = speakersList.get_first_child() }
        const defId = AudioSvc.defaultSpeaker(audio)?.id
        AudioSvc.speakers(audio).forEach((ep: any) => speakersList.append(buildSpeakerRow(ep, ep.id === defId)))
    }

    const refreshStreams = () => {
        let c = streamsList.get_first_child()
        while (c) { streamsList.remove(c); c = streamsList.get_first_child() }
        const streams = AudioSvc.streams(audio)
        if (streams.length === 0) {
            streamsList.append(emptyStreams)
        } else {
            streams.forEach((s: any) => streamsList.append(buildStreamRow(s)))
        }
    }

    const disposeDevices = AudioSvc.watchDevices(refreshSpeakers, audio)
    const disposeStreams = AudioSvc.watchStreams(refreshStreams, audio)
    box.connect("unrealize", () => { disposeDevices(); disposeStreams() })

    refreshSpeakers()
    refreshStreams()

    box.append(sectionLabel(t("settings.audio.group.output")))
    box.append(speakersList)
    box.append(sectionLabel(t("settings.audio.group.apps")))
    box.append(streamsList)

    return box
}

// ── Widget registration ───────────────────────────────────────────────────────

const volumeWidget: AtomicWidget = {
    id: "volume",
    category: "system",
    barOrder: 90,
    name: t("cc.volume.name"),
    icon: Icons.volumeHigh,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.TALL, WidgetSize.FULL_WIDTH],
    buildContent: (size, budget) => VolumeWidget().buildContent(size, budget),
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
}

export default volumeWidget
