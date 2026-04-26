import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import { execAsync } from "ags/process"
import { listGroup, createRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"

/**
 * Parses a monitor name and returns a friendly label.
 * e.g. "HDMI-A-1" → "HDMI-A-1", "eDP-1" → "eDP-1 (integrada)"
 */
function monitorLabel(name: string): string {
    if (name.startsWith("eDP")) return `${name} (${t("settings.display.label.integrada")})`
    return name
}

/**
 * Builds the resolution/refresh rate string for a monitor.
 */
function currentMode(mon: any): string {
    const w = mon.width ?? 0
    const h = mon.height ?? 0
    const hz = Math.round(mon.refresh_rate ?? mon.refreshRate ?? 0)
    if (!w || !h) return t("settings.display.label.desconocida")
    return `${w}×${h} @ ${hz}Hz`
}

/**
 * Returns available scale options as strings.
 * Hyprland supports arbitrary scale values; we offer common presets.
 */
const SCALE_PRESETS = ["1.0", "1.25", "1.5", "1.75", "2.0"]

function buildMonitorSection(mon: any): Gtk.Widget {
    const name: string   = mon.name ?? t("settings.display.label.monitor")
    const model: string  = mon.model ?? mon.description ?? ""
    const make: string   = mon.make ?? ""
    const description    = [make, model].filter(Boolean).join(" ") || name

    const { box, listBox } = listGroup(monitorLabel(name))

    // Current mode (static info)
    listBox.append(createRow(t("settings.display.row.label.resolucion-activa"), t("settings.display.row.desc.modo-actual"), staticLabel(currentMode(mon))))

    // Scale
    const currentScale = String(Math.round((mon.scale ?? 1.0) * 100) / 100)
    const drp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    SCALE_PRESETS.forEach(s => drp.append_text(`${s}×`))
    const initIdx = SCALE_PRESETS.findIndex(s => parseFloat(s) === parseFloat(currentScale))
    drp.active = initIdx >= 0 ? initIdx : 0

    drp.connect("changed", () => {
        const val = drp.get_active_text()
        if (!val) return
        const scale = parseFloat(val.replace("×", ""))
        execAsync([
            "hyprctl", "keyword", "monitor",
            `${name},preferred,auto,${scale}`
        ]).catch(e => console.error("[Display] scale change failed:", e))
    })

    listBox.append(createRow(t("settings.display.row.label.escala"), t("settings.display.row.desc.factor-de-escala-de-la-pantalla"), drp))

    // Make/model info
    if (description) {
        listBox.append(createRow(t("settings.display.row.label.modelo"), t("settings.display.row.desc.identificador-del-monitor"), staticLabel(description)))
    }

    // Transform / rotation — common values
    const ROT_NORMAL = t("settings.display.rotation.normal")
    const ROTATIONS = [ROT_NORMAL, "90°", "180°", "270°"]
    const TRANSFORM_MAP: Record<string, number> = {
        [ROT_NORMAL]: 0, "90°": 1, "180°": 2, "270°": 3,
    }
    const currentTransform = mon.transform ?? 0
    const rotationIdx = Math.max(0, currentTransform)

    const rotDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    ROTATIONS.forEach(r => rotDrp.append_text(r))
    rotDrp.active = rotationIdx < ROTATIONS.length ? rotationIdx : 0

    rotDrp.connect("changed", () => {
        const label = rotDrp.get_active_text()
        if (!label) return
        const t = TRANSFORM_MAP[label] ?? 0
        execAsync([
            "hyprctl", "keyword", "monitor",
            `${name},preferred,auto,1,transform,${t}`
        ]).catch(e => console.error("[Display] rotation change failed:", e))
    })

    listBox.append(createRow(t("settings.display.row.label.rotacion"), t("settings.display.row.desc.orientacion-de-la-pantalla"), rotDrp))

    // VRR (Variable Refresh Rate) — per monitor
    // vrr values: 0=off, 1=on (fullscreen), 2=fullscreen+window
    const VRR_OPTS = [
        t("settings.display.vrr.desactivado"),
        t("settings.display.vrr.solo-pantalla-completa"),
        t("settings.display.vrr.siempre"),
    ]
    const currentVrr = mon.vrr ?? 0
    const vrrDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    VRR_OPTS.forEach(o => vrrDrp.append_text(o))
    vrrDrp.active = currentVrr < VRR_OPTS.length ? currentVrr : 0

    vrrDrp.connect("changed", () => {
        const idx = vrrDrp.active
        execAsync(["hyprctl", "keyword", "misc:vrr", String(idx)])
            .catch(e => console.error("[Display] vrr change failed:", e))
    })

    listBox.append(createRow(t("settings.display.row.label.vrr-freesync"), t("settings.display.row.desc.tasa-de-refresco-variable-requiere-panta"), vrrDrp))

    box.append(listBox)
    return box
}

export default function DisplayPage() {
    const page = pageBox("display-page")
    page.append(pageHeader(t("settings.display.page.title.pantalla"), t("settings.display.page.subtitle.configura-resolucion-escala-y-orientacio")))

    const hypr = AstalHyprland.get_default()
    if (!hypr) {
        const err = new Gtk.Label({
            label: t("settings.display.label.servicio-hyprland-no-disponible"),
            css_classes: ["settings-placeholder"],
            margin_top: 40,
        })
        page.append(err)
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

    monitors.forEach(mon => {
        page.append(buildMonitorSection(mon))
    })

    // Note about persistence
    const { box: noteBox, listBox: noteList } = listGroup("")
    noteList.append(createRow(
        t("settings.display.row.label.cambios-temporales"),
        t("settings.display.row.desc.los-cambios-se-aplican-en-vivo-pero-no-p"),
        new Gtk.Image({ icon_name: Icons.info, pixel_size: 18, opacity: 0.6, valign: Gtk.Align.CENTER })
    ))
    noteBox.append(noteList)
    page.append(noteBox)

    return page
}
