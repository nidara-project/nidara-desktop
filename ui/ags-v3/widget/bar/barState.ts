import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

const SETTINGS_FILE = `${GLib.get_home_dir()}/.config/crystal-shell/bar-settings.json`

export interface BarSettings {
    showAppTitle: boolean
    showWorkspaces: boolean
    showSystemMenu: boolean
}

const DEFAULTS: BarSettings = {
    showAppTitle: true,
    showWorkspaces: true,
    showSystemMenu: true,
}

let _settings: BarSettings = { ...DEFAULTS }
try {
    const raw = JSON.parse(readFile(SETTINGS_FILE)) as Partial<BarSettings>
    _settings = { ...DEFAULTS, ...raw }
} catch {}

export const barSettings: BarSettings = _settings

const _listeners = new Set<(s: BarSettings) => void>()

export function onBarSettingsChanged(fn: (s: BarSettings) => void) {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
}

export function updateBarSettings(partial: Partial<BarSettings>) {
    Object.assign(barSettings, partial)
    try {
        const dir = `${GLib.get_home_dir()}/.config/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(SETTINGS_FILE, JSON.stringify(barSettings, null, 2))
    } catch (e) {
        console.error("[BarSettings] Failed to persist:", e)
    }
    _listeners.forEach(fn => fn(barSettings))
}
