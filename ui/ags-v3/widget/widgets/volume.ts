import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import { execAsync } from "ags/process"
import { makeHSlider } from "../common/Slider"
import { VolumeWidget } from "../control-center/Sliders"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

// Shared Cairo volume slider for the endpoint/stream rows (target has 0–1 `volume`).
function volSlider(target: any, valLabel: Gtk.Label, refreshMute: () => void): Gtk.Widget {
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
    })
}

// ── Bar icon (dynamic, reflects mute/volume level) ────────────────────────────

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

    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })

    if (speaker) {
        const ids = [
            speaker.connect("notify::volume", () => { image.gicon = getIcon() }),
            (speaker as any).connect?.("notify::mute", () => { image.gicon = getIcon() }) ?? 0,
        ]
        image.connect("unrealize", () => ids.forEach(id => { if (id) try { speaker.disconnect(id) } catch {} }))
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

    const muteImg = new Gtk.Image({ gicon: (speaker as any)?.mute ? Icons.volumeMuted : Icons.volumeHigh, pixel_size: 16, css_classes: ["cs-icon"] })
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

function endpointVolumeIcon(vol: number, muted: boolean) {
    if (muted || vol === 0) return Icons.volumeMuted
    if (vol < 0.34) return Icons.volumeLow
    if (vol < 0.67) return Icons.volumeMedium
    return Icons.volumeHigh
}

function buildSpeakerRow(ep: any, isDefault: boolean): Gtk.ListBoxRow {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })

    const header = new Gtk.Box({ spacing: 8 })
    header.append(new Gtk.Label({
        label: ep.description || ep.name || t("settings.audio.device"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["crystal-row-title"], ellipsize: 3, max_width_chars: 18,
    }))
    if (isDefault) {
        header.append(new Gtk.Label({
            label: t("settings.audio.default"),
            css_classes: ["settings-row-status", "accent-label"], valign: Gtk.Align.CENTER,
        }))
    } else {
        const setBtn = new Gtk.Button({ label: t("settings.audio.btn.set-default"), css_classes: ["flat", "compact-btn"], valign: Gtk.Align.CENTER })
        setBtn.connect("clicked", () => execAsync(["wpctl", "set-default", String(ep.id)]).catch((e: unknown) => console.error("[Volume CC]", e)))
        header.append(setBtn)
    }
    const muteImg = new Gtk.Image({ gicon: endpointVolumeIcon(ep.volume, ep.mute ?? false), pixel_size: 16, css_classes: ["cs-icon"] })
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["settings-icon-btn"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => { ep.mute = !ep.mute })
    ep.connect("notify::mute", () => { muteImg.gicon = endpointVolumeIcon(ep.volume, ep.mute ?? false) })
    header.append(muteBtn)
    box.append(header)

    const valLabel = new Gtk.Label({ label: `${Math.round(ep.volume * 100)}%`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const scale = volSlider(ep, valLabel, () => { muteImg.gicon = endpointVolumeIcon(ep.volume, ep.mute ?? false) })
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

function buildStreamRow(stream: any): Gtk.ListBoxRow {
    const appName = stream.description || stream.name || "App"
    const rawIcon: string = stream.icon ?? ""
    const iconName = (rawIcon && rawIcon !== "audio-card-symbolic")
        ? rawIcon
        : (stream.name?.toLowerCase() ?? "audio-x-generic-symbolic")

    const box = new Gtk.Box({ spacing: 10, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10, valign: Gtk.Align.CENTER })
    const muteImg = new Gtk.Image({ gicon: endpointVolumeIcon(stream.volume, stream.mute ?? false), pixel_size: 16, css_classes: ["cs-icon"] })
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["settings-icon-btn", "flat"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => { stream.mute = !stream.mute })
    stream.connect("notify::mute", () => { muteImg.gicon = endpointVolumeIcon(stream.volume, stream.mute ?? false) })
    box.append(new Gtk.Image({ icon_name: iconName, pixel_size: 16, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
    box.append(muteBtn)
    box.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["crystal-row-title"], ellipsize: 3, max_width_chars: 16,
    }))
    const valLabel = new Gtk.Label({ label: `${Math.round(stream.volume * 100)}%`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const scale = volSlider(stream, valLabel, () => { muteImg.gicon = endpointVolumeIcon(stream.volume, stream.mute ?? false) })
    box.append(scale)
    box.append(valLabel)
    const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
    row.set_child(box)
    return row
}

function buildCCDetail(_onClose: () => void): Gtk.Widget {
    const audio = AstalWp.get_default()?.audio
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })

    if (!audio) {
        box.append(new Gtk.Label({
            label: t("settings.audio.error.no-service"),
            css_classes: ["crystal-row-subtitle"],
            margin_top: 12, margin_start: 14, halign: Gtk.Align.START,
        }))
        return box
    }

    const sectionLabel = (text: string) => new Gtk.Label({
        label: text, css_classes: ["cc-detail-section-label"],
        halign: Gtk.Align.START, margin_start: 14, margin_top: 4,
    })

    const speakersList = new Gtk.ListBox({ css_classes: ["crystal-list"], selection_mode: Gtk.SelectionMode.NONE })
    const streamsList  = new Gtk.ListBox({ css_classes: ["crystal-list"], selection_mode: Gtk.SelectionMode.NONE })
    const emptyStreams  = new Gtk.Label({
        label: t("settings.audio.no-apps"),
        css_classes: ["crystal-row-subtitle"],
        margin_top: 8, margin_bottom: 8, margin_start: 14, halign: Gtk.Align.START,
    })

    const refreshSpeakers = () => {
        let c = speakersList.get_first_child()
        while (c) { speakersList.remove(c); c = speakersList.get_first_child() }
        const defId = (audio.default_speaker as any)?.id
        const speakers: any[] = (audio as any).get_speakers?.() ?? []
        speakers.forEach((ep: any) => speakersList.append(buildSpeakerRow(ep, ep.id === defId)))
    }

    const refreshStreams = () => {
        let c = streamsList.get_first_child()
        while (c) { streamsList.remove(c); c = streamsList.get_first_child() }
        const streams: any[] = (audio as any).get_streams?.() ?? []
        if (streams.length === 0) {
            streamsList.append(emptyStreams)
        } else {
            streams.forEach((s: any) => streamsList.append(buildStreamRow(s)))
        }
    }

    const sigs = [
        audio.connect("speaker-added", refreshSpeakers),
        audio.connect("speaker-removed", refreshSpeakers),
        audio.connect("notify::default-speaker", refreshSpeakers),
        audio.connect("stream-added", refreshStreams),
        audio.connect("stream-removed", refreshStreams),
    ]
    box.connect("unrealize", () => sigs.forEach(id => { try { audio.disconnect(id) } catch {} }))

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
    name: t("cc.volume.name"),
    icon: Icons.volumeHigh,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.TALL, WidgetSize.FULL_WIDTH],
    buildContent: (size) => VolumeWidget().buildContent(size),
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
}

export default volumeWidget
