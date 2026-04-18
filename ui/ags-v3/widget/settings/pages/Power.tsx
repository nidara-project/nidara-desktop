import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { listGroup, pageHeader, pageBox, dropdownRow, createRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

// ── hypridle config ───────────────────────────────────────────────────────────
// The symlink at ~/.config/hypr/hypridle.conf resolves to the correct writable
// target in both dev mode (repo file) and system mode (~/.config/crystal-shell/).
const HYPRIDLE_CONF = `${GLib.get_home_dir()}/.config/hypr/hypridle.conf`

interface IdleConfig { screenOff: number; lock: number; suspend: number }

const parseHypridle = (): IdleConfig => {
    try {
        const [, bytes] = Gio.File.new_for_path(HYPRIDLE_CONF).load_contents(null)
        const content = new TextDecoder().decode(bytes)
        const regex = /listener\s*\{([^}]+)\}/g
        let m
        const blocks: { timeout: number; onTimeout: string }[] = []
        while ((m = regex.exec(content)) !== null) {
            const body = m[1]
            const timeout = parseInt(body.match(/timeout\s*=\s*(\d+)/)?.[1] ?? "0")
            const onTimeout = body.match(/on-timeout\s*=\s*(.+)/)?.[1]?.trim() ?? ""
            blocks.push({ timeout, onTimeout })
        }
        return {
            screenOff: blocks.find(b => b.onTimeout.includes("dpms off"))?.timeout ?? 0,
            lock:      blocks.find(b => b.onTimeout.includes("crystal-lock") || b.onTimeout.includes("lock-session") || b.onTimeout.includes("hyprlock"))?.timeout ?? 0,
            suspend:   blocks.find(b => b.onTimeout.includes("suspend"))?.timeout ?? 0,
        }
    } catch {
        return { screenOff: 300, lock: 600, suspend: 0 }
    }
}

const writeHypridle = ({ screenOff, lock, suspend }: IdleConfig) => {
    const lines = [
        "# --- HYPRIDLE - Crystal Shell Idle Management ---",
        "# Edited via Settings → Energía → Inactividad",
        "",
        "general {",
        "    lock_cmd = crystal-lock",
        "    before_sleep_cmd = crystal-lock",
        "    after_sleep_cmd = hyprctl dispatch dpms on",
        "    ignore_dbus_inhibit = false",
        "}",
        "",
    ]
    if (screenOff > 0) lines.push(
        "listener {",
        `    timeout = ${screenOff}`,
        "    on-timeout = hyprctl dispatch dpms off",
        "    on-resume  = hyprctl dispatch dpms on",
        "}", ""
    )
    if (lock > 0) lines.push(
        "listener {",
        `    timeout = ${lock}`,
        "    on-timeout = crystal-lock",
        "}", ""
    )
    if (suspend > 0) lines.push(
        "listener {",
        `    timeout = ${suspend}`,
        "    on-timeout = systemctl suspend",
        "}", ""
    )
    try {
        Gio.File.new_for_path(HYPRIDLE_CONF).replace_contents(
            new TextEncoder().encode(lines.join("\n")),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        )
        execAsync(["bash", "-c", "pkill hypridle; sleep 0.3; uwsm app -- hypridle"]).catch(() => {})
    } catch (e) {
        console.error("[PowerPage] Failed to write hypridle config:", e)
    }
}

// ── Option tables ─────────────────────────────────────────────────────────────
const screenOpts = [
    { label: t("settings.power.label.nunca"),                              s: 0    },
    { label: `2 ${t("settings.power.time.min")}`,                         s: 120  },
    { label: `5 ${t("settings.power.time.min")}`,                         s: 300  },
    { label: `10 ${t("settings.power.time.min")}`,                        s: 600  },
    { label: `20 ${t("settings.power.time.min")}`,                        s: 1200 },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800 },
]
const lockOpts = [
    { label: t("settings.power.label.nunca"),                              s: 0    },
    { label: `5 ${t("settings.power.time.min")}`,                         s: 300  },
    { label: `10 ${t("settings.power.time.min")}`,                        s: 600  },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800 },
    { label: `1 ${t("settings.power.time.hora")}`,                        s: 3600 },
    { label: `2 ${t("settings.power.time.horas")}`,                       s: 7200 },
]
const suspendOpts = [
    { label: t("settings.power.label.nunca"),                              s: 0     },
    { label: `15 ${t("settings.power.time.min")}`,                        s: 900   },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800  },
    { label: `1 ${t("settings.power.time.hora")}`,                        s: 3600  },
    { label: `2 ${t("settings.power.time.horas")}`,                       s: 7200  },
    { label: `3 ${t("settings.power.time.horas")}`,                       s: 10800 },
]

const closestLabel = (opts: { label: string; s: number }[], seconds: number) => {
    if (seconds === 0) return t("settings.power.label.nunca")
    let best = opts[0]
    for (const o of opts) if (Math.abs(o.s - seconds) < Math.abs(best.s - seconds)) best = o
    return best.label
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PowerPage() {
    const page = pageBox("power-page")
    page.append(pageHeader(t("settings.power.page.title.energia"), t("settings.power.page.subtitle.gestion-de-energia-inactividad-y-bloqueo")))

    // ── Performance profile ───────────────────────────────────────────────────
    const profileGroup = listGroup(t("settings.power.group.perfil-de-rendimiento"))
    profileGroup.listBox.selection_mode = Gtk.SelectionMode.SINGLE

    const profiles = [
        { id: "performance", label: t("settings.power.label.alto-rendimiento"),  icon: "power-profile-performance-symbolic" },
        { id: "balanced",    label: t("settings.power.label.equilibrado"),        icon: "power-profile-balanced-symbolic" },
        { id: "power-saver", label: t("settings.power.label.ahorro-de-energia"),  icon: "power-profile-power-saver-symbolic" },
    ]
    const checkIcons = new Map<string, Gtk.Image>()

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({ spacing: 16, margin_start: 16, margin_end: 16, margin_top: 14, margin_bottom: 14 })
        rowContent.append(new Gtk.Image({ icon_name: p.icon, pixel_size: 20, css_classes: ["sidebar-icon"] }))
        rowContent.append(new Gtk.Label({ label: p.label, hexpand: true, halign: Gtk.Align.START, css_classes: ["settings-row-label"] }))
        const checkIcon = new Gtk.Image({ icon_name: "object-select-symbolic", css_classes: ["profile-check", "suggested-action"], pixel_size: 16, visible: false })
        rowContent.append(checkIcon)
        checkIcons.set(p.id, checkIcon)
        const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        row.set_child(rowContent); row.set_name(p.id)
        profileGroup.listBox.append(row)
    })

    profileGroup.listBox.connect("row-selected", (_: any, row: any) => {
        checkIcons.forEach(i => { i.visible = false })
        if (row) {
            const id = row.get_name()
            if (id) {
                checkIcons.get(id)!.visible = true
                execAsync(["powerprofilesctl", "set", id]).catch(console.error)
            }
        }
    })

    page.append(profileGroup.box)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        execAsync(["powerprofilesctl", "get"]).then((cur: string) => {
            const id = cur.trim()
            profiles.forEach((p, i) => {
                if (p.id === id) {
                    const row = profileGroup.listBox.get_row_at_index(i)
                    if (row) profileGroup.listBox.select_row(row)
                }
            })
        }).catch(console.error)
        return GLib.SOURCE_REMOVE
    })

    // ── Idle / lock ───────────────────────────────────────────────────────────
    const cfg = parseHypridle()
    const idleGroup = listGroup(t("settings.power.group.inactividad-y-bloqueo"))
    let current = { ...cfg }

    const save = () => writeHypridle(current)

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.row.label.apagar-pantalla"),
        t("settings.power.row.desc.tiempo-sin-actividad-antes-de-apagar-la-"),
        closestLabel(screenOpts, cfg.screenOff),
        screenOpts.map(o => o.label),
        (label) => {
            current.screenOff = screenOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.row.label.bloquear-sesion"),
        t("settings.power.row.desc.tiempo-sin-actividad-antes-de-bloquear-l"),
        closestLabel(lockOpts, cfg.lock),
        lockOpts.map(o => o.label),
        (label) => {
            current.lock = lockOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.row.label.suspender"),
        t("settings.power.row.desc.tiempo-sin-actividad-antes-de-suspender-"),
        closestLabel(suspendOpts, cfg.suspend),
        suspendOpts.map(o => o.label),
        (label) => {
            current.suspend = suspendOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    // Info note: lock must fire before suspend
    const note = new Gtk.Label({
        label: t("settings.power.label.el-bloqueo-debe-ocurrir-antes-que-la-sus"),
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
        margin_start: 10,
        margin_top: 4,
        wrap: true,
        max_width_chars: 55,
    })
    idleGroup.box.append(note)

    page.append(idleGroup.box)

    return page
}
