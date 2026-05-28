import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import { listGroup, createRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import monitorConfig from "../../../core/MonitorConfig"

function monitorLabel(name: string): string {
    if (name.startsWith("eDP")) return `${name} (${t("settings.display.label.integrada")})`
    return name
}

function currentMode(mon: any): string {
    const w = mon.width ?? 0
    const h = mon.height ?? 0
    const hz = Math.round(mon.refresh_rate ?? mon.refreshRate ?? 0)
    if (!w || !h) return t("settings.display.label.desconocida")
    return `${w}×${h} @ ${hz}Hz`
}

const SCALE_PRESETS = ["1.0", "1.25", "1.5", "1.75", "2.0"]

function buildMonitorSection(mon: any): Gtk.Widget {
    const name: string  = mon.name ?? t("settings.display.label.monitor")
    const model: string = mon.model ?? mon.description ?? ""
    const make: string  = mon.make ?? ""
    const description   = [make, model].filter(Boolean).join(" ") || name

    const { box, listBox } = listGroup(monitorLabel(name))

    // Current mode (static info)
    listBox.append(createRow(
        t("settings.display.row.label.resolucion-activa"),
        t("settings.display.row.desc.modo-actual"),
        staticLabel(currentMode(mon))
    ))

    // Scale
    const currentScale = String(monitorConfig.getScale(name))
    const scaleStrings = SCALE_PRESETS.map(s => `${s}×`)
    const scaleModel = new Gtk.StringList({ strings: scaleStrings })
    const scaleDrp = new Gtk.DropDown({ model: scaleModel, valign: Gtk.Align.CENTER })
    const initScaleIdx = SCALE_PRESETS.findIndex(s => parseFloat(s) === parseFloat(currentScale))
    scaleDrp.selected = initScaleIdx >= 0 ? initScaleIdx : 0

    scaleDrp.connect("notify::selected", () => {
        const val = scaleStrings[scaleDrp.selected]
        if (!val) return
        monitorConfig.setScale(name, parseFloat(val.replace("×", "")))
    })

    listBox.append(createRow(
        t("settings.display.row.label.escala"),
        t("settings.display.row.desc.factor-de-escala-de-la-pantalla"),
        scaleDrp
    ))

    // Make/model info
    if (description) {
        listBox.append(createRow(
            t("settings.display.row.label.modelo"),
            t("settings.display.row.desc.identificador-del-monitor"),
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
        t("settings.display.row.label.rotacion"),
        t("settings.display.row.desc.orientacion-de-la-pantalla"),
        rotDrp
    ))

    // VRR
    const VRR_OPTS = [
        t("settings.display.vrr.desactivado"),
        t("settings.display.vrr.solo-pantalla-completa"),
        t("settings.display.vrr.siempre"),
    ]
    const vrrModel = new Gtk.StringList({ strings: VRR_OPTS })
    const vrrDrp = new Gtk.DropDown({ model: vrrModel, valign: Gtk.Align.CENTER })
    const currentVrr = monitorConfig.vrr
    vrrDrp.selected = currentVrr < VRR_OPTS.length ? currentVrr : 0

    vrrDrp.connect("notify::selected", () => {
        monitorConfig.setVrr(vrrDrp.selected)
    })

    listBox.append(createRow(
        t("settings.display.row.label.vrr-freesync"),
        t("settings.display.row.desc.tasa-de-refresco-variable-requiere-panta"),
        vrrDrp
    ))

    return box
}

export default function DisplayPage() {
    const page = pageBox("display-page")
    page.append(pageHeader(
        t("settings.display.page.title.pantalla"),
        t("settings.display.page.subtitle.configura-resolucion-escala-y-orientacio")
    ))

    const hypr = AstalHyprland.get_default()
    if (!hypr) {
        page.append(new Gtk.Label({
            label: t("settings.display.label.servicio-hyprland-no-disponible"),
            css_classes: ["settings-placeholder"],
            margin_top: 40,
        }))
        return page
    }

    const monitors: any[] = hypr.get_monitors() ?? []

    if (monitors.length === 0) {
        page.append(new Gtk.Label({
            label: t("settings.display.label.no-se-detectaron-monitores"),
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
