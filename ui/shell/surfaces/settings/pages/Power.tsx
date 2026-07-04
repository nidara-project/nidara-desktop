import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { listGroup, pageBox, dropdownRow, createRow } from "../SettingsHelpers"
import Icons from "../../../core/Icons"
import { t } from "../../../core/i18n"
import Theme from "../../../core/ThemeManager"
import { safeDisconnect } from "../../../core/signals"

// ── hypridle config ───────────────────────────────────────────────────────────
// The symlink at ~/.config/hypr/hypridle.conf resolves to the correct writable
// target in both dev mode (repo file) and system mode (~/.config/nidara/).
const HYPRIDLE_CONF = `${GLib.get_home_dir()}/.config/hypr/hypridle.conf`

interface IdleConfig { screenOff: number; lock: number; suspend: number }

const parseHypridle = (): IdleConfig => {
    try {
        const [, bytes] = Gio.File.new_for_path(HYPRIDLE_CONF).load_contents(null)
        // Drop comment lines first: a commented-out `# listener { ... }` block
        // otherwise parses as real and gets silently re-enabled on the next save
        // (this is how a phantom 30-min auto-suspend shipped on 2026-06-10).
        const content = new TextDecoder().decode(bytes)
            .split("\n").filter(l => !/^\s*#/.test(l)).join("\n")
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
            screenOff: blocks.find(b => /dpms.*(off|disable)/.test(b.onTimeout))?.timeout ?? 0,
            lock:      blocks.find(b => b.onTimeout.includes("nidara-lock") || b.onTimeout.includes("lock-session"))?.timeout ?? 0,
            suspend:   blocks.find(b => b.onTimeout.includes("suspend"))?.timeout ?? 0,
        }
    } catch {
        return { screenOff: 300, lock: 600, suspend: 0 }
    }
}

const writeHypridle = ({ screenOff, lock, suspend }: IdleConfig) => {
    const lines = [
        "# --- HYPRIDLE - Nidara Idle Management ---",
        "# Managed by Nidara Settings → Power → Idle & Lock",
        "",
        "general {",
        "    lock_cmd = nidara-lock",
        "    before_sleep_cmd = nidara-before-sleep",
        "    after_sleep_cmd = nidara-after-sleep",
        "    ignore_dbus_inhibit = false",
        "}",
        "",
    ]
    if (screenOff > 0) lines.push(
        "listener {",
        `    timeout = ${screenOff}`,
        // Lua-parser syntax — the legacy `hyprctl dispatch dpms off` is a Lua
        // error on Nidara's Hyprland and leaves the screen unrecoverable on wake
        `    on-timeout = hyprctl dispatch 'hl.dsp.dpms({ action = "disable" })'`,
        `    on-resume  = hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'`,
        "}", ""
    )
    if (lock > 0) lines.push(
        "listener {",
        `    timeout = ${lock}`,
        "    on-timeout = nidara-lock",
        "}", ""
    )
    if (suspend > 0) lines.push(
        "listener {",
        `    timeout = ${suspend}`,
        "    on-timeout = systemctl suspend",
        "}", ""
    )
    try {
        // FileCreateFlags.NONE follows the symlink and writes through to the real
        // target. REPLACE_DESTINATION would replace the symlink itself with a
        // plain file, silently detaching the config from its install-mode target.
        Gio.File.new_for_path(HYPRIDLE_CONF).replace_contents(
            new TextEncoder().encode(lines.join("\n")),
            null, false, Gio.FileCreateFlags.NONE, null
        )
        // Single-owner restart. The session launches hypridle via `uwsm app -s b`
        // (hyprland.lua), but the hypridle package ALSO ships a user unit, and
        // `systemctl --user restart hypridle` would start a SECOND instance next
        // to the session one — both register idle timers and fight over the
        // org.freedesktop.ScreenSaver name, dropping app inhibitors (videos kept
        // playing while the screen went dark — incident 2026-06-10). Stop the
        // unit if present, kill any stragglers, wait until truly dead, relaunch.
        execAsync(["bash", "-c",
            "systemctl --user stop hypridle.service 2>/dev/null; " +
            "pkill -x -TERM hypridle 2>/dev/null; " +
            "for i in $(seq 1 30); do pgrep -x hypridle >/dev/null || break; sleep 0.1; done; " +
            "pkill -x -KILL hypridle 2>/dev/null; " +
            "exec uwsm app -s b -- hypridle"
        ]).catch(() => {})
    } catch (e) {
        console.error("[PowerPage] Failed to write hypridle config:", e)
    }
}

// ── Option tables ─────────────────────────────────────────────────────────────
const screenOpts = [
    { label: t("settings.power.opt.never"),                              s: 0    },
    { label: `2 ${t("settings.power.time.min")}`,                         s: 120  },
    { label: `5 ${t("settings.power.time.min")}`,                         s: 300  },
    { label: `10 ${t("settings.power.time.min")}`,                        s: 600  },
    { label: `20 ${t("settings.power.time.min")}`,                        s: 1200 },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800 },
]
const lockOpts = [
    { label: t("settings.power.opt.never"),                              s: 0    },
    { label: `5 ${t("settings.power.time.min")}`,                         s: 300  },
    { label: `10 ${t("settings.power.time.min")}`,                        s: 600  },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800 },
    { label: `1 ${t("settings.power.time.hour")}`,                        s: 3600 },
    { label: `2 ${t("settings.power.time.hours")}`,                       s: 7200 },
]
const suspendOpts = [
    { label: t("settings.power.opt.never"),                              s: 0     },
    { label: `15 ${t("settings.power.time.min")}`,                        s: 900   },
    { label: `30 ${t("settings.power.time.min")}`,                        s: 1800  },
    { label: `1 ${t("settings.power.time.hour")}`,                        s: 3600  },
    { label: `2 ${t("settings.power.time.hours")}`,                       s: 7200  },
    { label: `3 ${t("settings.power.time.hours")}`,                       s: 10800 },
]

const closestLabel = (opts: { label: string; s: number }[], seconds: number) => {
    if (seconds === 0) return t("settings.power.opt.never")
    let best = opts[0]
    for (const o of opts) if (Math.abs(o.s - seconds) < Math.abs(best.s - seconds)) best = o
    return best.label
}

// Selection checkmark, Cairo-drawn. `accent-icon` (color: var(--nidara-accent)) on a
// Gtk.Image has NO effect here: our icons are Gio.FileIcon → raw SVG files, rendered
// outside GTK's symbolic-icon recolor pipeline (the only lever we have on them is
// `-gtk-icon-filter: invert(1)`, a fixed black/white toggle, not a real recolor) —
// anything that needs a genuinely live-coloured glyph goes through Cairo instead
// (same reasoning as the battery glyph). NOT accent-coloured on purpose: the row
// itself already carries the accent (`.nidara-row:selected` → `--nidara-state-selected`,
// which tracks the live accent too), so an accent check on an accent-tinted row has
// almost no contrast. Plain mode-aware white/black — the same "readable on whatever's
// under it" role `--nidara-text` plays everywhere else — reads clearly regardless of
// which accent is picked. Path matches Lucide's "check" (`M20 6 9 17l-5-5` in a 24×24
// viewBox), scaled to the widget's own size.
function buildSelectionCheck(size = 16): Gtk.Widget {
    const da = new Gtk.DrawingArea({ width_request: size, height_request: size, valign: Gtk.Align.CENTER })
    da.set_can_target(false)
    da.set_draw_func((_w: Gtk.DrawingArea, cr: any, w: number, h: number) => {
        const v = Theme.isDark ? 1 : 0
        const s = Math.min(w, h) / 24
        cr.setLineWidth(2 * s)
        cr.setLineCap(1)   // ROUND
        cr.setLineJoin(1)  // ROUND
        cr.setSourceRGBA(v, v, v, 1)
        cr.moveTo(4 * s, 12 * s)
        cr.lineTo(9 * s, 17 * s)
        cr.lineTo(20 * s, 6 * s)
        cr.stroke()
    })
    const sigId = Theme.connect("changed", () => da.queue_draw())
    da.connect("unrealize", () => safeDisconnect(Theme, sigId))
    return da
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PowerPage() {
    const page = pageBox("power-page")

    // ── Performance profile ───────────────────────────────────────────────────
    const profileGroup = listGroup(t("settings.power.group.profile"))
    profileGroup.listBox.selection_mode = Gtk.SelectionMode.SINGLE

    const profiles = [
        { id: "performance", label: t("settings.power.profile.performance"),  icon: Icons.zap },
        { id: "balanced",    label: t("settings.power.profile.balanced"),        icon: Icons.battery },
        { id: "power-saver", label: t("settings.power.profile.power-saver"),  icon: Icons.leaf },
    ]
    const checkIcons = new Map<string, Gtk.Widget>()

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({ spacing: 16, margin_start: 16, margin_end: 16, margin_top: 14, margin_bottom: 14 })
        rowContent.append(new Gtk.Image({ gicon: p.icon, pixel_size: 20, css_classes: ["sidebar-icon", "nd-icon"] }))
        rowContent.append(new Gtk.Label({ label: p.label, hexpand: true, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))
        const checkIcon = buildSelectionCheck(16)
        checkIcon.visible = false
        rowContent.append(checkIcon)
        checkIcons.set(p.id, checkIcon)
        const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
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
    const idleGroup = listGroup(t("settings.power.group.idle"))
    let current = { ...cfg }

    const save = () => writeHypridle(current)

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.screen-off"),
        t("settings.power.screen-off.desc"),
        closestLabel(screenOpts, cfg.screenOff),
        screenOpts.map(o => o.label),
        (label) => {
            const v = screenOpts.find(o => o.label === label)?.s ?? 0
            if (v === current.screenOff) return
            current.screenOff = v
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.lock"),
        t("settings.power.lock.desc"),
        closestLabel(lockOpts, cfg.lock),
        lockOpts.map(o => o.label),
        (label) => {
            const v = lockOpts.find(o => o.label === label)?.s ?? 0
            if (v === current.lock) return
            current.lock = v
            save()
        }
    ))

    idleGroup.listBox.append(dropdownRow(
        t("settings.power.suspend"),
        t("settings.power.suspend.desc"),
        closestLabel(suspendOpts, cfg.suspend),
        suspendOpts.map(o => o.label),
        (label) => {
            const v = suspendOpts.find(o => o.label === label)?.s ?? 0
            if (v === current.suspend) return
            current.suspend = v
            save()
        }
    ))

    // Info note: lock must fire before suspend
    const note = new Gtk.Label({
        label: t("settings.power.lock-note"),
        css_classes: ["nidara-row-subtitle"],
        halign: Gtk.Align.START,
        margin_start: 10,
        // Footnote binds to the card ABOVE it (NidaraList box is now spacing:0);
        // 8px matches the title→card attachment gap. See design-system.md.
        margin_top: 8,
        wrap: true,
        max_width_chars: 55,
    })
    idleGroup.box.append(note)

    page.append(idleGroup.box)

    return page
}
