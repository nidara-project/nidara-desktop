import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { makeHSlider, makeVerticalFillTile, bindWhileRealized } from "../../../lib/nidara-kit"
import { CCWidgetSpec, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import * as AudioSvc from "../../core/AudioService"

function buildHorizontalSlider(
    iconNameLow: Gio.FileIcon,
    iconNameHigh: Gio.FileIcon,
    getValue: () => number,
    onChange: (v: number) => void,
    onExtChange: (cb: (v: number) => void) => (() => void),
): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        css_classes: ["nidara-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: false,
        margin_start: 4, margin_end: 4,
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(getValue())}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    const sliderWidget = makeHSlider({
        value: getValue(),
        onChange: (v) => onChange(v / 100),
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => onExtChange((v) => cb(Math.round(v * 100))),
    })

    box.append(new Gtk.Image({ gicon: iconNameLow,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] }))
    box.append(sliderWidget)
    box.append(new Gtk.Image({ gicon: iconNameHigh, pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] }))
    box.append(valueLabel)

    return box
}

function buildVerticalSlider(
    getIcon: () => Gio.FileIcon,
    getValue: () => number,
    onChange: (v: number) => void,
    onExtChange: (cb: (v: number) => void) => (() => void),
    iconSubscribe?: (sync: () => void) => (() => void),
): Gtk.Widget {
    // Capsule-filling vertical slider: fill rises edge-to-edge, % overlaid on top,
    // icon at the bottom (shared with brightness).
    return makeVerticalFillTile(getIcon, {
        value: getValue(),
        onChange: (v) => onChange(v / 100),
        onExtChange: (cb) => onExtChange((v) => cb(Math.round(v * 100))),
    }, iconSubscribe)
}

// Small (1×1) variant: round mute-toggle icon, mirroring the bar icon.
// Takes a GETTER, not the endpoint: see the note on VolumeWidget for why nothing
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

export function VolumeWidget(): CCWidgetSpec {
    // 🔑 Resolved on every use, NEVER captured. This spec is built once, at shell
    // start, and two things are false at that moment: the audio graph has not populated the
    // endpoint's properties yet (`volume` reads 0 even when the sink is at 40%), and
    // on a machine where pipewire settles after the shell there may be no default
    // speaker at all — captured, that null is permanent and the tile is dead for the
    // session. It also changes when the user switches output.
    const speaker = () => AudioSvc.defaultSpeaker()

    const getValue = () => { const s = speaker(); return s ? Math.round(s.volume * 100) / 100 : 0.5 }
    const onChange = (v: number) => { const s = speaker(); if (s) s.volume = v }

    // PRIMES before connecting, then re-targets when the default endpoint changes.
    // The kit's slider re-subscribes on every realize (`bindWhileRealized`), so a hook
    // that only pushes FUTURE changes leaves the slider showing whatever it was built
    // with — which is how the Control Center displayed 0% from login until something
    // changed the volume from outside (found on the 0.7.1 VM sweep, with the sink at
    // 40% and unmuted). Same defect the accessibility text slider had in #165: the
    // hook was armed and nobody read on the way in.
    const onExtChange = (cb: (v: number) => void): (() => void) => {
        let stopVolume: (() => void) | null = null
        const sync = () => { const s = speaker(); if (s) cb(s.volume) }
        const rewire = () => {
            stopVolume?.()
            stopVolume = AudioSvc.watchVolume(speaker(), sync)
            sync()
        }
        rewire()
        const stopDevices = AudioSvc.watchDevices(rewire)
        return () => { stopVolume?.(); stopDevices() }
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE) {
            return buildVolumeIcon(speaker)
        }
        if (size === WidgetSize.TALL) {
            return buildVerticalSlider(
                () => { const s = speaker(); return s ? AudioSvc.targetVolumeIcon(s) : Icons.volumeMuted },
                () => getValue() * 100, onChange, onExtChange,
                // Follows the default endpoint; never captures it.
                (sync) => AudioSvc.watchDefaultSpeaker(sync),
            )
        }
        return buildHorizontalSlider(Icons.volumeLow, Icons.volumeHigh, () => getValue() * 100, onChange, onExtChange)
    }

    return {
        id: "volume",
        name: t("cc.volume.name"),
        defaultSize: WidgetSize.FULL_WIDTH,
        // Slider tier mapping: Small=icon, Medium=1×2 vertical, Large=4×1 wide.
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.TALL, WidgetSize.FULL_WIDTH],
        buildContent,
    }
}
