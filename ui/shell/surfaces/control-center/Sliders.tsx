import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import AstalWp from "gi://AstalWp"
import { makeHSlider, makeVerticalFillTile } from "../../common/Slider"
import { CCWidgetSpec, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import * as AudioSvc from "../../core/AudioService"
import { safeDisconnect } from "../../core/signals"

function buildHorizontalSlider(
    iconNameLow: Gio.FileIcon,
    iconNameHigh: Gio.FileIcon,
    getValue: () => number,
    onChange: (v: number) => void,
    onExtChange: (cb: (v: number) => void) => (() => void),
): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        css_classes: ["cc-atomic-slider-box-horizontal"],
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
function buildVolumeIcon(speaker: any): Gtk.Widget {
    const getIcon = () => speaker ? AudioSvc.targetVolumeIcon(speaker) : Icons.volumeMuted
    const icon = new Gtk.Image({ gicon: getIcon(), pixel_size: 28, css_classes: ["nd-icon"] })
    const btn = new Gtk.Button({
        css_classes: ["cc-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
        child: icon,
    })
    btn.connect("clicked", () => { AudioSvc.toggleMute(speaker); icon.gicon = getIcon() })
    if (speaker) {
        const ids = [
            speaker.connect("notify::volume", () => { icon.gicon = getIcon() }),
            speaker.connect?.("notify::mute", () => { icon.gicon = getIcon() }) ?? 0,
        ]
        btn.connect("unrealize", () => ids.forEach((id: number) => safeDisconnect(speaker, id)))
    }
    return btn
}

export function VolumeWidget(): CCWidgetSpec {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getValue = () => speaker ? Math.round(speaker.volume * 100) / 100 : 0.5
    const onChange = (v: number) => { if (speaker) speaker.volume = v }
    const onExtChange = (cb: (v: number) => void): (() => void) => {
        if (!speaker) return () => {}
        const id = speaker.connect("notify::volume", () => cb(speaker.volume))
        return () => safeDisconnect(speaker, id)
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        const current = getValue()
        if (size === WidgetSize.SINGLE) {
            return buildVolumeIcon(speaker)
        }
        if (size === WidgetSize.TALL) {
            return buildVerticalSlider(
                () => speaker ? AudioSvc.targetVolumeIcon(speaker) : Icons.volumeMuted,
                () => current * 100, onChange, onExtChange,
                (sync) => speaker ? AudioSvc.watchVolume(speaker, sync) : () => {},
            )
        }
        return buildHorizontalSlider(Icons.volumeLow, Icons.volumeHigh, () => current * 100, onChange, onExtChange)
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
