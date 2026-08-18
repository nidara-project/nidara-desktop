import { Gtk } from "ags/gtk4"
import { listGroup, pageBox, bindWhileRealized } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import * as AudioSvc from "../../../core/AudioService"
import { safeDisconnect } from "../../../core/signals"
import { NidaraButton, NidaraRow, makeVolumeSlider } from "../../../../lib/nidara-kit"

// ── Volume row (devices and per-app streams) ─────────────────────────────────

/**
 * The shape both audio lists share: leading icon, name, trailing controls, and the
 * volume slider on the row's SECOND line — `NidaraRow`'s `footer` slot.
 *
 * Device rows and stream rows were separate hand-rolled builders that were
 * identical from the mute button down: same slider, same value label, same two
 * endpoint glyphs, same `notify::mute` wiring, same outer metrics. They differed
 * in the leading icon and in whether a default-device control rides ahead of mute,
 * which is now two arguments.
 *
 * ⚠️ The footer takes NO `margin_start`. NidaraRow leaves that to the caller because
 * a secondary button (Settings → Widgets' "Configure") indents to line up with the
 * title — but the slider is this row's PRIMARY control and spans the full content
 * width, as it did hand-rolled.
 */
function createVolumeRow(
    target: any,
    title: string,
    leadingIcon: Gtk.Widget,
    /** Rides ahead of the mute button: the default-device badge or its button. */
    defaultControl?: Gtk.Widget,
): Gtk.ListBoxRow {
    const muteImg = new Gtk.Image({
        gicon: AudioSvc.targetVolumeIcon(target),
        pixel_size: 18, css_classes: ["nd-icon"],
    })
    const muteBtn = new Gtk.Button({
        child: muteImg, css_classes: ["settings-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => { AudioSvc.toggleMute(target) })

    const trailing = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    if (defaultControl) trailing.append(defaultControl)
    trailing.append(muteBtn)

    const valLabel = new Gtk.Label({
        label: `${Math.round(target.volume * 100)}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0,
    })
    const scale = makeVolumeSlider(target, {
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExternal: () => { muteImg.gicon = AudioSvc.targetVolumeIcon(target) },
    })

    const slider = new Gtk.Box({ spacing: 8 })
    slider.append(new Gtk.Image({ gicon: Icons.volumeLow, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    slider.append(scale)
    slider.append(new Gtk.Image({ gicon: Icons.volumeHigh, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    slider.append(valLabel)

    // NidaraRow, not createRow: a sound card and a playing app are hardware state,
    // not settings, so they stay out of the search index. The title's one-line
    // ellipsis now comes from the component — this page is exactly where the
    // three-line "Starship/Matisse HD Audio Controller Analog Stereo" was measured.
    const row = NidaraRow(title, "", trailing, [], undefined, leadingIcon, slider)

    // ⚠️ The mute icon's subscription must die with the ROW, because the target does
    // not: an audio endpoint outlives every row ever built for it. This was a bare
    // `target.connect("notify::mute", …)` — and the rows are rebuilt on every device
    // change AND on every realize of the page, so each visit hung another permanent
    // handler on the same endpoint, each holding a discarded widget alive. The
    // slider one line below never had the bug: it takes its external sync through
    // the kit, which hands back a disposer. This is the same contract, by hand.
    bindWhileRealized(row, () => {
        const id = target.connect("notify::mute", () => {
            muteImg.gicon = AudioSvc.targetVolumeIcon(target)
        })
        // Re-realizing after a spell away: the icon may be stale by now.
        muteImg.gicon = AudioSvc.targetVolumeIcon(target)
        return () => safeDisconnect(target, id)
    })

    return row
}

// ── Device row (speakers / mics) ──────────────────────────────────────────────

function createDeviceRow(
    endpoint: any,
    isMic: boolean,
    isDefault: boolean,
    onSetDefault: () => void,
): Gtk.ListBoxRow {
    let defaultControl: Gtk.Widget
    if (isDefault) {
        defaultControl = new Gtk.Label({
            label: t("settings.audio.default"),
            css_classes: ["accent-label"],
            valign: Gtk.Align.CENTER,
        })
    } else {
        const setBtn = NidaraButton({
            label: t("settings.audio.btn.set-default"),
            variant: "ghost",
            valign: Gtk.Align.CENTER,
        })
        setBtn.connect("clicked", onSetDefault)
        defaultControl = setBtn
    }

    return createVolumeRow(
        endpoint,
        endpoint.description || endpoint.name || t("settings.audio.device"),
        new Gtk.Image({
            gicon: isMic ? Icons.mic : Icons.speaker,
            pixel_size: 18, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER,
        }),
        defaultControl,
    )
}

// ── Stream row (per-app) ──────────────────────────────────────────────────────

function createStreamRow(stream: any): Gtk.ListBoxRow {
    return createVolumeRow(
        stream,
        stream.description || stream.name || "App",
        // Real app icon — NO nd-icon: that class recolours/inverts monochrome UI
        // glyphs, which mangles a full-colour app icon. Sized to match the device
        // leading icon.
        new Gtk.Image({ icon_name: AudioSvc.streamIconName(stream), pixel_size: 24, valign: Gtk.Align.CENTER }),
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
    // 🔑 The graph is asked for on every use, never captured — not even to decide
    // whether to build the page. Settings caches a page for the window's lifetime,
    // so a one-time `if (!audio) return "no service"` freezes that verdict forever,
    // and `core/wireplumber.ts` answers null until PipeWire has replied (AstalWp
    // handed back an object immediately and filled it in later, which is what hid
    // this shape). Every accessor below defaults to the live graph, and the two
    // placeholders — "no service" is gone, "no hardware" stays — are decided in
    // `applyVisibility`, which runs on every realize.
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

    // A group whose list is empty shows as a bare header over a 6px sliver of card
    // — which is what a VM (no microphone, nothing playing) made obvious: two of
    // the three sections were furniture with nothing in them. Each section is
    // present exactly when it has something to say, and `banner` covers the case
    // where none of them do. There is no "no apps playing" placeholder here on
    // purpose: absence of a section IS the message, and the Control Center's
    // volume popover is the surface where that string still earns its keep.
    const applyVisibility = () => {
        const speakers = AudioSvc.speakers().length
        const mics     = AudioSvc.microphones().length
        const streams  = AudioSvc.streams().length

        banner.visible = speakers === 0 && mics === 0
        speakerGroup.box.visible = speakers > 0
        micGroup.box.visible     = mics > 0
        streamGroup.box.visible  = streams > 0
    }

    // ── Devices ───────────────────────────────────────────────────────────────
    const refreshDevices = () => {
        [speakerGroup, micGroup].forEach(g => {
            let c = g.listBox.get_first_child()
            while (c) { g.listBox.remove(c); c = g.listBox.get_first_child() }
        })

        const defaultSpk = AudioSvc.defaultSpeaker()
        const defaultMic = AudioSvc.defaultMicrophone()

        AudioSvc.speakers().forEach(ep => {
            const isDef = defaultSpk && ep.id === defaultSpk.id
            speakerGroup.listBox.append(createDeviceRow(ep, false, isDef, () => AudioSvc.setDefault(ep)))
        })
        AudioSvc.microphones().forEach(ep => {
            const isDef = defaultMic && ep.id === defaultMic.id
            micGroup.listBox.append(createDeviceRow(ep, true, isDef, () => AudioSvc.setDefault(ep)))
        })

        applyVisibility()
    }

    // ── Streams ───────────────────────────────────────────────────────────────
    const refreshStreams = () => {
        let c = streamGroup.listBox.get_first_child()
        while (c) { streamGroup.listBox.remove(c); c = streamGroup.listBox.get_first_child() }

        AudioSvc.streams().forEach(s => streamGroup.listBox.append(createStreamRow(s)))
        applyVisibility()
    }

    // ── Signals ───────────────────────────────────────────────────────────────
    // Re-watched on every realize: the page is cached, so watching once left the
    // device and stream lists frozen at whatever was plugged in the first time the
    // user opened this page. The refresh belongs inside for the same reason.
    bindWhileRealized(page, () => {
        const disposeDevices = AudioSvc.watchDevices(refreshDevices)
        const disposeStreams = AudioSvc.watchStreams(refreshStreams)
        refreshDevices()
        refreshStreams()
        return () => { disposeDevices(); disposeStreams() }
    })

    page.append(speakerGroup.box)
    page.append(micGroup.box)
    page.append(streamGroup.box)

    return page
}
