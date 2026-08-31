import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "../../lib/process"

const HYPRIDLE_CONF = `${GLib.get_home_dir()}/.config/hypr/hypridle.conf`

export interface IdleConfig {
    screenOff: number
    lock: number
    suspend: number
}

const _listeners = new Set<(cfg: IdleConfig) => void>()

export const parseHypridle = (): IdleConfig => {
    try {
        const [, bytes] = Gio.File.new_for_path(HYPRIDLE_CONF).load_contents(null)
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

export const writeHypridle = (cfg: IdleConfig) => {
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
    if (cfg.screenOff > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.screenOff}`,
        `    on-timeout = hyprctl dispatch 'hl.dsp.dpms({ action = "disable" })'`,
        `    on-resume  = hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'`,
        "}", ""
    )
    if (cfg.lock > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.lock}`,
        "    on-timeout = nidara-lock",
        "}", ""
    )
    if (cfg.suspend > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.suspend}`,
        "    on-timeout = systemctl suspend",
        "}", ""
    )
    try {
        Gio.File.new_for_path(HYPRIDLE_CONF).replace_contents(
            new TextEncoder().encode(lines.join("\n")),
            null, false, Gio.FileCreateFlags.NONE, null
        )
        execAsync(["bash", "-c",
            "systemctl --user stop hypridle.service 2>/dev/null; " +
            "pkill -x -TERM hypridle 2>/dev/null; " +
            "for i in $(seq 1 30); do pgrep -x hypridle >/dev/null || break; sleep 0.1; done; " +
            "pkill -x -KILL hypridle 2>/dev/null; " +
            "exec uwsm app -s b -- hypridle"
        ]).catch(() => {})
    } catch (e) {
        console.error("[PowerConfig] Failed to write hypridle config:", e)
    }
    _listeners.forEach(fn => fn(cfg))
}

export function onHypridleChanged(fn: (cfg: IdleConfig) => void): () => void {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
}

export function getIdleConfig(): IdleConfig {
    return parseHypridle()
}

export function updateIdleConfig(partial: Partial<IdleConfig>) {
    const current = parseHypridle()
    const updated = { ...current, ...partial }
    writeHypridle(updated)
}
