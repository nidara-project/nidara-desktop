import Gtk from "gi://Gtk?version=4.0"
import { PANEL_W, AtomicWidget, WidgetSize, makeHSliderTile } from "../common/widget-kit"
import { makeVolumeSlider, makeVerticalFillTile, bindWhileRealized } from "../../lib/nidara-kit"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import * as AudioSvc from "../core/AudioService"
import { safeDisconnect } from "../core/signals"
import { NidaraButton } from "../../lib/nidara-kit/button"

// ── CC tile content ───────────────────────────────────────────────────────────

// Small (1×1) variant: round mute-toggle icon, mirroring the bar icon.
// Takes a GETTER, not the endpoint: see the note on buildCCContent for why nothing
// here may capture the default speaker.
function buildVolumeIcon(speaker: () => any): Gtk.Widget {
    const getIcon = () => { const s = speaker(); return s ? AudioSvc.targetVolumeIcon(s) : Icons.volumeMuted }
    const icon = new Gtk.Image({ gicon: getIcon(), pixel_size: 28, css_classes: ["nd-icon"] })
    const btn = new Gtk.Button({
        css_classes: ["nidara-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
        child: icon,
    })
    btn.connect("clicked", () => { AudioSvc.toggleMute(speaker()); icon.gicon = getIcon() })
    // Re-subscribed AND re-read on every realize: subscribing once and disconnecting
    // on "unrealize" is a subscription that survives exactly one hide (same trap the
    // kit's slider documents), and it also has to re-target when the default endpoint
    // changes.
    bindWhileRealized(btn, () => AudioSvc.watchDefaultSpeaker(() => { icon.gicon = getIcon() }))
    return btn
}

// 🔑 Resolved on every use, NEVER captured. This runs at shell start, and two things
// are false at that moment: the audio graph has not populated the endpoint's
// properties yet (`volume` reads 0 even when the sink is at 40%), and on a machine
// where pipewire settles after the shell there may be no default speaker at all —
// captured, that null is permanent and the tile is dead for the session. It also
// changes when the user switches output.
const speaker = () => AudioSvc.defaultSpeaker()

const getVolumePct = () => { const s = speaker(); return s ? Math.round(s.volume * 100) : 50 }
const setVolumePct = (pct: number) => { const s = speaker(); if (s) s.volume = pct / 100 }

// PRIMES before connecting, then re-targets when the default endpoint changes. The
// kit's slider re-subscribes on every realize (`bindWhileRealized`), so a hook that
// only pushes FUTURE changes leaves the slider showing whatever it was built with —
// which is how the Control Center displayed 0% from login until something changed the
// volume from outside (found on the 0.7.1 VM sweep, with the sink at 40% and
// unmuted). Same defect the accessibility text slider had in #165: the hook was armed
// and nobody read on the way in.
function onVolumeExtChange(cb: (pct: number) => void): () => void {
    let stopVolume: (() => void) | null = null
    const sync = () => { const s = speaker(); if (s) cb(Math.round(s.volume * 100)) }
    const rewire = () => {
        stopVolume?.()
        stopVolume = AudioSvc.watchVolume(speaker(), sync)
        sync()
    }
    rewire()
    const stopDevices = AudioSvc.watchDevices(rewire)
    return () => { stopVolume?.(); stopDevices() }
}

// Slider tier mapping: Small=icon, Medium=1×2 vertical fill, Large=4×1 wide row.
function buildCCContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) return buildVolumeIcon(speaker)

    if (size === WidgetSize.TALL) {
        // Capsule-filling vertical slider: fill rises edge-to-edge, % overlaid on
        // top, icon at the bottom — the same kit component brightness uses.
        return makeVerticalFillTile(
            () => { const s = speaker(); return s ? AudioSvc.targetVolumeIcon(s) : Icons.volumeMuted },
            { value: getVolumePct(), onChange: setVolumePct, onExtChange: onVolumeExtChange },
            // Follows the default endpoint; never captures it.
            (sync) => AudioSvc.watchDefaultSpeaker(sync),
        )
    }

    return makeHSliderTile({
        low:  { icon: Icons.volumeLow },
        high: { icon: Icons.volumeHigh },
        getValue: getVolumePct,
        onChange: setVolumePct,
        onExtChange: onVolumeExtChange,
    })
}

// ── Bar icon (dynamic, reflects mute/volume level) ────────────────────────────

function buildBarContent(): Gtk.Widget {
    // `speaker` is the module-level getter, resolved on every use and never captured
    // — see the note on it above; the bar icon has the same stake as the CC tile.
    const getIcon = () => { const s = speaker(); return s ? AudioSvc.targetVolumeIcon(s) : Icons.volumeMuted }

    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })

    // Re-read AND re-subscribed on every realize, and re-targeted when the default
    // endpoint changes: a bare unrealize-cleanup is a subscription that survives
    // exactly one hide.
    bindWhileRealized(image, () => AudioSvc.watchDefaultSpeaker(() => { image.gicon = getIcon() }))

    return image
}

// ── Bar expansion panel content ───────────────────────────────────────────────

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const speaker = AudioSvc.defaultSpeaker()

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
        muteBtn.connect("unrealize", () => safeDisconnect(speaker, id))
    }

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(muteBtn)
    row.append(sliderWidget)
    row.append(volLabel)

    return row
}

// ── CC detail: per-device output sliders + per-app stream sliders ─────────────

function buildSpeakerRow(ep: any, isDefault: boolean): Gtk.ListBoxRow {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })

    const header = new Gtk.Box({ spacing: 8 })
    header.append(new Gtk.Label({
        label: ep.description || ep.name || t("settings.audio.device"),
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"], ellipsize: 3, max_width_chars: 18,
    }))
    if (isDefault) {
        header.append(new Gtk.Label({
            label: t("settings.audio.default"),
            css_classes: ["accent-label"], valign: Gtk.Align.CENTER,
        }))
    } else {
        const setBtn = NidaraButton({
            label: t("settings.audio.btn.set-default"),
            variant: "ghost", size: "compact", valign: Gtk.Align.CENTER,
        })
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

    // Same shape as buildSpeakerRow above and as Settings → Audio's stream row:
    // header (identity + mute) on top, slider underneath. A single horizontal line
    // is what this row used to be, and at CC width it squeezed the app name to
    // ~16 chars to make room for a slider that ended up too short to aim with.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })

    const header = new Gtk.Box({ spacing: 8 })
    // Real app icon — NO `nd-icon`. That class is `-gtk-icon-filter: invert(1)`
    // (_reset.scss), meant for our monochrome UI glyphs; on a full-colour app icon
    // it inverts the artwork. Same note as Settings → Audio's stream row.
    header.append(new Gtk.Image({ icon_name: iconName, pixel_size: 20, valign: Gtk.Align.CENTER }))
    header.append(new Gtk.Label({
        label: appName,
        halign: Gtk.Align.START, hexpand: true,
        css_classes: ["nidara-row-title"], ellipsize: 3, max_width_chars: 18,
    }))

    const muteImg = new Gtk.Image({ gicon: AudioSvc.targetVolumeIcon(stream), pixel_size: 16, css_classes: ["nd-icon"] })
    // `settings-icon-btn` alone: it is a Nidara class, unscoped in _components.scss,
    // and already paints the whole thing (transparent, tinted hover, 28px box).
    // The Adwaita `flat` that used to ride along added nothing here and only made
    // the row depend on rendering inside one of the two scopes that restyle
    // Adwaita classes — the sibling row above never had it.
    const muteBtn = new Gtk.Button({ child: muteImg, css_classes: ["settings-icon-btn"], valign: Gtk.Align.CENTER })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(stream) })
    stream.connect("notify::mute", () => { muteImg.gicon = AudioSvc.targetVolumeIcon(stream) })
    header.append(muteBtn)
    box.append(header)

    const valLabel = new Gtk.Label({ label: `${Math.round(stream.volume * 100)}%`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const scale = makeVolumeSlider(stream, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(stream) },
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

function buildCCDetail(_onClose: () => void): Gtk.Widget {
    const audio = AudioSvc.audio()
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })

    if (!audio) {
        box.append(new Gtk.Label({
            label: t("settings.audio.error.no-service"),
            css_classes: ["nidara-row-subtitle"],
            margin_top: 12, margin_start: 12, halign: Gtk.Align.START,
        }))
        return box
    }

    const sectionLabel = (text: string) => new Gtk.Label({
        label: text, css_classes: ["nidara-detail-section-label"],
        halign: Gtk.Align.START, margin_start: 12, margin_top: 4,
    })

    const speakersList = new Gtk.ListBox({ css_classes: ["nidara-list"], selection_mode: Gtk.SelectionMode.NONE })
    const streamsList  = new Gtk.ListBox({ css_classes: ["nidara-list"], selection_mode: Gtk.SelectionMode.NONE })
    const emptyStreams  = new Gtk.Label({
        label: t("settings.audio.no-apps"),
        css_classes: ["nidara-row-subtitle"],
        margin_top: 8, margin_bottom: 8, margin_start: 12, halign: Gtk.Align.START,
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
    defaultInBar: true,
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.TALL, WidgetSize.FULL_WIDTH],
    buildContent: (size, _budget) => buildCCContent(size),
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
    // Gauge fill for the TALL tile only — SINGLE (icon) and FULL_WIDTH (its own
    // inline slider row) aren't a whole-island gauge, so they get 0 (no fill).
    getFill: (size) => size === WidgetSize.TALL ? (AudioSvc.defaultSpeaker()?.volume ?? 0) : 0,
    // 🔑 The GAUGE's repaint trigger, and the third place in this widget that must
    // not capture the endpoint. A CC spec is built ONCE at shell start; resolving
    // the speaker here bound the fill to whatever existed at that instant, and to
    // NOTHING on a machine where PipeWire settles after the shell — the label and
    // the icon kept up (they have their own subscriptions) while the pink fill
    // stayed frozen at the level of the first paint. Seen on screen: 86 % → 5 %
    // with the capsule still full.
    watchActive: (cb) => AudioSvc.watchDefaultSpeaker(cb),
}

export default volumeWidget
