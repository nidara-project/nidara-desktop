import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { listGroup, pageHeader, pageBox, dropdownRow, createRow } from "../SettingsHelpers"

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
            lock:      blocks.find(b => b.onTimeout.includes("lock-session") || b.onTimeout.includes("hyprlock"))?.timeout ?? 0,
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
        "    lock_cmd = pidof hyprlock || hyprlock",
        "    before_sleep_cmd = loginctl lock-session",
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
        "    on-timeout = loginctl lock-session",
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
    { label: "Nunca",   s: 0    },
    { label: "2 min",   s: 120  },
    { label: "5 min",   s: 300  },
    { label: "10 min",  s: 600  },
    { label: "20 min",  s: 1200 },
    { label: "30 min",  s: 1800 },
]
const lockOpts = [
    { label: "Nunca",   s: 0    },
    { label: "5 min",   s: 300  },
    { label: "10 min",  s: 600  },
    { label: "30 min",  s: 1800 },
    { label: "1 hora",  s: 3600 },
    { label: "2 horas", s: 7200 },
]
const suspendOpts = [
    { label: "Nunca",   s: 0     },
    { label: "15 min",  s: 900   },
    { label: "30 min",  s: 1800  },
    { label: "1 hora",  s: 3600  },
    { label: "2 horas", s: 7200  },
    { label: "3 horas", s: 10800 },
]

const closestLabel = (opts: { label: string; s: number }[], seconds: number) => {
    if (seconds === 0) return "Nunca"
    let best = opts[0]
    for (const o of opts) if (Math.abs(o.s - seconds) < Math.abs(best.s - seconds)) best = o
    return best.label
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PowerPage() {
    const page = pageBox("power-page")
    page.append(pageHeader("Energía", "Gestión de energía, inactividad y bloqueo"))

    // ── Performance profile ───────────────────────────────────────────────────
    const profileGroup = listGroup("Perfil de Rendimiento")
    profileGroup.listBox.selection_mode = Gtk.SelectionMode.SINGLE

    const profiles = [
        { id: "performance", label: "Alto Rendimiento",  icon: "power-profile-performance-symbolic" },
        { id: "balanced",    label: "Equilibrado",        icon: "power-profile-balanced-symbolic" },
        { id: "power-saver", label: "Ahorro de Energía",  icon: "power-profile-power-saver-symbolic" },
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
    const idleGroup = listGroup("Inactividad y Bloqueo")
    let current = { ...cfg }

    const save = () => writeHypridle(current)

    idleGroup.listBox.append(dropdownRow(
        "Apagar pantalla",
        "Tiempo sin actividad antes de apagar la pantalla",
        closestLabel(screenOpts, cfg.screenOff),
        screenOpts.map(o => o.label),
        (label) => {
            current.screenOff = screenOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        "Bloquear sesión",
        "Tiempo sin actividad antes de bloquear con hyprlock",
        closestLabel(lockOpts, cfg.lock),
        lockOpts.map(o => o.label),
        (label) => {
            current.lock = lockOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        "Suspender",
        "Tiempo sin actividad antes de suspender el equipo",
        closestLabel(suspendOpts, cfg.suspend),
        suspendOpts.map(o => o.label),
        (label) => {
            current.suspend = suspendOpts.find(o => o.label === label)?.s ?? 0
            save()
        }
    ))

    // Info note: lock must fire before suspend
    const note = new Gtk.Label({
        label: "El bloqueo debe ocurrir antes que la suspensión para garantizar seguridad.",
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
