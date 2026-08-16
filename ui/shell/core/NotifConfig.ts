import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/notif-config.json`

// 🔑 Do-not-disturb is deliberately NOT in here. It lives in AstalNotifd, whose
// `dont_disturb` is backed by GSettings (`io.astal.notifd dont-disturb`) and so
// already persists across sessions. A second copy here could only disagree with
// it — which is exactly what the old `dndDefault` did (removed 2026-08-16).
interface NotifSettings {
    popupTimeout: number  // seconds, default 6
}

const DEFAULTS: NotifSettings = {
    popupTimeout: 6,
}

let _settings: NotifSettings = { ...DEFAULTS }
try {
    if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
        const data = JSON.parse(readFile(CONFIG_PATH)) as Partial<NotifSettings>
        // Key-by-key, not a spread of `data`: an existing install's file still has
        // the retired `dndDefault`, and a spread would carry it into `_settings`
        // and write it back out on every save, forever.
        if (typeof data.popupTimeout === "number") _settings.popupTimeout = data.popupTimeout
    }
} catch {}

function save() {
    try {
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify(_settings, null, 2))
    } catch (e) {
        console.error("[NotifConfig] Save failed:", e)
    }
}

const _listeners = new Set<() => void>()

export const notifConfig = {
    get popupTimeout() { return _settings.popupTimeout },
    get popupTimeoutMs() { return _settings.popupTimeout * 1000 },

    setPopupTimeout(seconds: number) {
        _settings.popupTimeout = Math.round(seconds)
        save()
        _listeners.forEach(fn => fn())
    },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default notifConfig
