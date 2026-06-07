import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import { listGroup, createRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import monitorConfig from "../../../core/MonitorConfig"

function monitorLabel(name: string): string {
    if (name.startsWith("eDP")) return `${name} (${t("settings.display.label.builtin")})`
    return name
}

function currentMode(mon: any): string {
    const w = mon.width ?? 0
    const h = mon.height ?? 0
    const hz = Math.round(mon.refresh_rate ?? mon.refreshRate ?? 0)
    if (!w || !h) return t("settings.display.label.unknown")
    return `${w}×${h} @ ${hz}Hz`
}

const SCALE_PRESETS = ["1.0", "1.25", "1.5", "1.75", "2.0"]

// Hyprland requires a fractional scale to divide the native resolution into a whole
// number of logical pixels; otherwise it rejects it and snaps to a valid one. Offer
// only exact-valid scales for this monitor's resolution (same as GNOME).
function isScaleValid(w: number, h: number, s: number): boolean {
    if (!w || !h) return true
    return Math.abs(Math.round(w / s) - w / s) < 0.001
        && Math.abs(Math.round(h / s) - h / s) < 0.001
}

function buildMonitorSection(mon: any): Gtk.Widget {
    const name: string  = mon.name ?? t("settings.display.label.monitor")
    const model: string = mon.model ?? mon.description ?? ""
    const make: string  = mon.make ?? ""
    const description   = [make, model].filter(Boolean).join(" ") || name

    const { box, listBox } = listGroup(monitorLabel(name))

    // Current mode (static info)
    listBox.append(createRow(
        t("settings.display.resolution"),
        t("settings.display.resolution.desc"),
        staticLabel(currentMode(mon))
    ))

    // Scale — only exact-valid presets for this monitor (1.0 is always valid).
    const currentScaleNum = parseFloat(String(monitorConfig.getScale(name)))
    const validStrings = SCALE_PRESETS.filter(s => {
        const sv = parseFloat(s)
        return sv === 1 || isScaleValid(mon.width ?? 0, mon.height ?? 0, sv)
    })
    // Keep the currently-applied scale selectable even if it isn't an exact preset.
    if (!validStrings.some(s => Math.abs(parseFloat(s) - currentScaleNum) < 0.001)) {
        validStrings.push(String(currentScaleNum))
        validStrings.sort((a, b) => parseFloat(a) - parseFloat(b))
    }
    const scaleStrings = validStrings.map(s => `${s}×`)
    const scaleModel = new Gtk.StringList({ strings: scaleStrings })
    const scaleDrp = new Gtk.DropDown({ model: scaleModel, valign: Gtk.Align.CENTER })
    const initScaleIdx = validStrings.findIndex(s => Math.abs(parseFloat(s) - currentScaleNum) < 0.001)
    scaleDrp.selected = initScaleIdx >= 0 ? initScaleIdx : 0

    scaleDrp.connect("notify::selected", () => {
        const val = validStrings[scaleDrp.selected]
        if (val == null) return
        monitorConfig.setScale(name, parseFloat(val))
    })

    listBox.append(createRow(
        t("settings.display.scale"),
        t("settings.display.scale.desc"),
        scaleDrp
    ))

    // Make/model info
    if (description) {
        listBox.append(createRow(
            t("settings.display.model"),
            t("settings.display.model.desc"),
            staticLabel(description)
        ))
    }

    // Rotation
    const ROT_NORMAL = t("settings.display.rotation.normal")
    const ROTATIONS = [ROT_NORMAL, "90°", "180°", "270°"]
    const TRANSFORM_MAP: Record<string, number> = {
        [ROT_NORMAL]: 0, "90°": 1, "180°": 2, "270°": 3,
    }

    const rotModel = new Gtk.StringList({ strings: ROTATIONS })
    const rotDrp = new Gtk.DropDown({ model: rotModel, valign: Gtk.Align.CENTER })
    const currentTransform = monitorConfig.getTransform(name)
    rotDrp.selected = currentTransform < ROTATIONS.length ? currentTransform : 0

    rotDrp.connect("notify::selected", () => {
        monitorConfig.setTransform(name, TRANSFORM_MAP[ROTATIONS[rotDrp.selected]] ?? 0)
    })

    listBox.append(createRow(
        t("settings.display.rotation"),
        t("settings.display.rotation.desc"),
        rotDrp
    ))

    // VRR
    const VRR_OPTS = [
        t("settings.display.vrr.off"),
        t("settings.display.vrr.fullscreen"),
        t("settings.display.vrr.always"),
    ]
    const vrrModel = new Gtk.StringList({ strings: VRR_OPTS })
    const vrrDrp = new Gtk.DropDown({ model: vrrModel, valign: Gtk.Align.CENTER })
    const currentVrr = monitorConfig.vrr
    vrrDrp.selected = currentVrr < VRR_OPTS.length ? currentVrr : 0

    vrrDrp.connect("notify::selected", () => {
        monitorConfig.setVrr(vrrDrp.selected)
    })

    listBox.append(createRow(
        t("settings.display.vrr"),
        t("settings.display.vrr.desc"),
        vrrDrp
    ))

    return box
}

export default function DisplayPage() {
    const page = pageBox("display-page")
    page.append(pageHeader(
        t("settings.display.title"),
        t("settings.display.subtitle")
    ))

    const hypr = AstalHyprland.get_default()
    if (!hypr) {
        page.append(new Gtk.Label({
            label: t("settings.display.error.no-hyprland"),
            css_classes: ["settings-placeholder"],
            margin_top: 40,
        }))
        return page
    }

    const monitors: any[] = hypr.get_monitors() ?? []

    if (monitors.length === 0) {
        page.append(new Gtk.Label({
            label: t("settings.display.error.no-monitors"),
            css_classes: ["settings-placeholder"],
            margin_top: 40,
        }))
        return page
    }

    monitorConfig.init(monitors)

    monitors.forEach(mon => {
        page.append(buildMonitorSection(mon))
    })

    return page
}
