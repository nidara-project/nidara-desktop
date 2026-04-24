import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/notif-config.json`

interface NotifSettings {
    popupTimeout: number  // seconds, default 6
    dndDefault: boolean   // enable DND on login, default false
}

const DEFAULTS: NotifSettings = {
    popupTimeout: 6,
    dndDefault: false,
}

let _settings: NotifSettings = { ...DEFAULTS }
try {
    if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
        const data = JSON.parse(readFile(CONFIG_PATH)) as Partial<NotifSettings>
        _settings = { ...DEFAULTS, ...data }
    }
} catch {}

function save() {
    try {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
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
    get dndDefault() { return _settings.dndDefault },

    setPopupTimeout(seconds: number) {
        _settings.popupTimeout = Math.round(seconds)
        save()
        _listeners.forEach(fn => fn())
    },

    setDndDefault(val: boolean) {
        _settings.dndDefault = val
        save()
        _listeners.forEach(fn => fn())
    },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default notifConfig
