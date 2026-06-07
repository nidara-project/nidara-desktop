import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import { listGroup, createRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import { showCrystalAlert } from "../../../../lib/crystal-ui"
import hs from "../../../core/HyprlandState"
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

function buildMonitorSection(mon: any, availableModes: string[]): Gtk.Widget {
    const name: string  = mon.name ?? t("settings.display.label.monitor")
    const model: string = mon.model ?? mon.description ?? ""
    const make: string  = mon.make ?? ""
    const description   = [make, model].filter(Boolean).join(" ") || name

    const { box, listBox } = listGroup(monitorLabel(name))

    // ── Scale dropdown (rebuilt when the resolution changes) ────────────────────
    // Only exact-valid presets for the current resolution (1.0 always valid).
    const buildScaleStrings = (w: number, h: number): string[] => {
        const vs = SCALE_PRESETS.filter(s => {
            const sv = parseFloat(s)
            return sv === 1 || isScaleValid(w, h, sv)
        })
        const cur = parseFloat(String(monitorConfig.getScale(name)))
        if (!vs.some(s => Math.abs(parseFloat(s) - cur) < 0.001)) {
            vs.push(String(cur)); vs.sort((a, b) => parseFloat(a) - parseFloat(b))
        }
        return vs
    }
    let scaleVals = buildScaleStrings(mon.width ?? 0, mon.height ?? 0)
    const scaleDrp = new Gtk.DropDown({ model: new Gtk.StringList({ strings: scaleVals.map(s => `${s}×`) }), valign: Gtk.Align.CENTER })
    let scaleApplying = false
    const syncScaleSel = () => {
        const cur = parseFloat(String(monitorConfig.getScale(name)))
        const i = scaleVals.findIndex(s => Math.abs(parseFloat(s) - cur) < 0.001)
        scaleDrp.selected = i >= 0 ? i : 0
    }
    syncScaleSel()
    scaleDrp.connect("notify::selected", () => {
        if (scaleApplying) return
        const v = scaleVals[scaleDrp.selected]
        if (v != null) monitorConfig.setScale(name, parseFloat(v))
    })
    const rebuildScaleOptions = (w: number, h: number) => {
        scaleApplying = true
        scaleVals = buildScaleStrings(w, h)
        scaleDrp.set_model(new Gtk.StringList({ strings: scaleVals.map(s => `${s}×`) }))
        syncScaleSel()
        scaleApplying = false
    }

    // ── Resolution + refresh (two dependent dropdowns, with revert safety) ───────
    type DMode = { w: number; h: number; hz: number }
    // AstalHyprland's Monitor.available_modes is always null, so the list is read
    // from `hyprctl monitors -j` by the page and passed in here.
    const rawModes: string[] = availableModes ?? []
    const modes: DMode[] = []
    for (const s of rawModes) {
        const m = String(s).match(/^(\d+)x(\d+)@([\d.]+)/)
        if (m) modes.push({ w: +m[1], h: +m[2], hz: Math.round(parseFloat(m[3])) })
    }
    const resKey = (w: number, h: number) => `${w}x${h}`
    const resList: { w: number; h: number }[] = []
    const hzByRes = new Map<string, number[]>()
    for (const md of modes) {
        const k = resKey(md.w, md.h)
        if (!hzByRes.has(k)) { hzByRes.set(k, []); resList.push({ w: md.w, h: md.h }) }
        const hzs = hzByRes.get(k)!
        if (!hzs.includes(md.hz)) hzs.push(md.hz)
    }
    resList.sort((a, b) => b.w * b.h - a.w * a.h)
    for (const hzs of hzByRes.values()) hzs.sort((a, b) => b - a)
    const hzForRes = (i: number) => hzByRes.get(resKey(resList[i].w, resList[i].h)) ?? []

    const curW = mon.width ?? (resList[0]?.w ?? 0)
    const curH = mon.height ?? (resList[0]?.h ?? 0)
    const curHz = Math.round(mon.refresh_rate ?? mon.refreshRate ?? 0)

    if (resList.length === 0) {
        // No mode list available — keep the static read-out.
        listBox.append(createRow(
            t("settings.display.resolution"), t("settings.display.resolution.desc"),
            staticLabel(currentMode(mon)),
        ))
    } else {
        let modeApplying = false
        let prevMode = `${curW}x${curH}@${curHz}`

        const resDrp = new Gtk.DropDown({ model: new Gtk.StringList({ strings: resList.map(r => `${r.w} × ${r.h}`) }), valign: Gtk.Align.CENTER })
        resDrp.selected = Math.max(0, resList.findIndex(r => r.w === curW && r.h === curH))

        const hzDrp = new Gtk.DropDown({ model: new Gtk.StringList({ strings: hzForRes(resDrp.selected).map(hz => `${hz} Hz`) }), valign: Gtk.Align.CENTER })
        const hzInit = hzForRes(resDrp.selected).findIndex(hz => hz === curHz)
        hzDrp.selected = hzInit >= 0 ? hzInit : 0

        const repopulateHz = (resIdx: number, preferHz?: number) => {
            const hzs = hzForRes(resIdx)
            hzDrp.set_model(new Gtk.StringList({ strings: hzs.map(hz => `${hz} Hz`) }))
            let idx = preferHz != null ? hzs.findIndex(h => h === preferHz) : 0
            hzDrp.selected = idx >= 0 ? idx : 0
        }

        const applyMode = () => {
            if (modeApplying) return
            const r = resList[resDrp.selected]
            const hzs = hzForRes(resDrp.selected)
            const hz = hzs[hzDrp.selected] ?? hzs[0]
            const newMode = `${r.w}x${r.h}@${hz}`
            if (newMode === prevMode) return
            monitorConfig.applyMode(name, newMode)
            showCrystalAlert({
                parent: box.get_root() as Gtk.Window,
                heading: t("settings.display.confirm.title"),
                countdown: {
                    seconds: 12, respondId: "revert",
                    format: (s) => t("settings.display.confirm.body").replace("%d", String(s)),
                },
                responses: [
                    { id: "revert", label: t("settings.display.confirm.revert") },
                    { id: "keep", label: t("settings.display.confirm.keep"), suggested: true },
                ],
                onResponse: (id) => {
                    if (id === "keep") {
                        prevMode = newMode
                        // The new resolution may invalidate the current scale.
                        if (!isScaleValid(r.w, r.h, monitorConfig.getScale(name))) monitorConfig.setScale(name, 1.0)
                        monitorConfig.commit()
                        rebuildScaleOptions(r.w, r.h)
                    } else {
                        monitorConfig.applyMode(name, prevMode)
                        const pm = prevMode.match(/^(\d+)x(\d+)@(\d+)/)
                        if (pm) {
                            modeApplying = true
                            const pi = resList.findIndex(rr => rr.w === +pm[1] && rr.h === +pm[2])
                            if (pi >= 0) { resDrp.selected = pi; repopulateHz(pi, +pm[3]) }
                            modeApplying = false
                        }
                    }
                },
            })
        }

        resDrp.connect("notify::selected", () => {
            if (modeApplying) return
            modeApplying = true; repopulateHz(resDrp.selected); modeApplying = false
            applyMode()
        })
        hzDrp.connect("notify::selected", () => applyMode())

        const resBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
        resBox.append(resDrp); resBox.append(hzDrp)
        listBox.append(createRow(
            t("settings.display.resolution"), t("settings.display.resolution.desc"), resBox,
        ))
    }

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

    // Rotation can leave the screen disorienting/hard to navigate, so it gets the
    // same revert-safety dialog as the resolution change.
    let rotApplying = false
    let prevTransform = currentTransform
    rotDrp.connect("notify::selected", () => {
        if (rotApplying) return
        const newT = TRANSFORM_MAP[ROTATIONS[rotDrp.selected]] ?? 0
        if (newT === prevTransform) return
        monitorConfig.applyTransform(name, newT)
        showCrystalAlert({
            parent: box.get_root() as Gtk.Window,
            heading: t("settings.display.confirm.title"),
            countdown: {
                seconds: 12, respondId: "revert",
                format: (s) => t("settings.display.confirm.body").replace("%d", String(s)),
            },
            responses: [
                { id: "revert", label: t("settings.display.confirm.revert") },
                { id: "keep", label: t("settings.display.confirm.keep"), suggested: true },
            ],
            onResponse: (id) => {
                if (id === "keep") {
                    prevTransform = newT
                    monitorConfig.commit()
                } else {
                    monitorConfig.applyTransform(name, prevTransform)
                    rotApplying = true
                    rotDrp.selected = prevTransform < ROTATIONS.length ? prevTransform : 0
                    rotApplying = false
                }
            },
        })
    })

    listBox.append(createRow(
        t("settings.display.rotation"),
        t("settings.display.rotation.desc"),
        rotDrp
    ))

    // VRR — order matches Hyprland's misc:vrr int: 0=off, 1=always, 2=fullscreen-only,
    // so the dropdown index equals the value applied (they were swapped before).
    const VRR_OPTS = [
        t("settings.display.vrr.off"),
        t("settings.display.vrr.always"),
        t("settings.display.vrr.fullscreen"),
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

    // Available modes come from HyprlandState's cache (read once from hyprctl there,
    // since AstalHyprland doesn't expose them) — no per-open re-shell.
    monitors.forEach(mon => {
        page.append(buildMonitorSection(mon, hs.getAvailableModes(mon.name)))
    })

    return page
}
