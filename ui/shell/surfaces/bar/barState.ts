import GLib from "gi://GLib"
import { readFile, writeFile } from "../../../lib/file"

const SETTINGS_FILE = `${GLib.get_home_dir()}/.config/nidara/bar-settings.json`

export interface BarSettings {
    showAppTitle: boolean
    launcherIcon: string
}

const DEFAULTS: BarSettings = {
    showAppTitle: true,
    launcherIcon: "nidara",
}

// Only KNOWN keys are read back. Two visibility toggles were retired in 0.6.0,
// both for the same reason: hiding the element removed the ONLY route to a
// capability, with nothing taking its place.
//
//  - `showSystemMenu` — the launcher capsule owns the only GUI path to log out /
//    restart / shut down (`SystemMenu.tsx`), and no exit-session keybind ships.
//  - `showWorkspaces` — it hid the bar's centre box, which by then held the
//    Activity Island's capsule and indicator chips, not the workspace switcher
//    its label still described. Renaming it was not enough: with the capsule
//    hidden there is no recording indicator at all (the CC banner row is gone
//    and the `screenrecord` widget is not `defaultInBar`), so the setting let
//    you screen-record with nothing on screen saying so. It also never hid the
//    island it was named after — the expanded modes are separate overlay
//    children of the island surface (`IslandWindow.mount`), so Super+A, Super+W
//    and the battery-critical alert opened regardless.
//
// Filtering here rather than spreading `raw` means those dead keys are dropped
// from the file on the next write instead of being re-persisted forever.
let _settings: BarSettings = { ...DEFAULTS }
try {
    const raw = JSON.parse(readFile(SETTINGS_FILE)) as Partial<BarSettings>
    for (const k of Object.keys(DEFAULTS) as (keyof BarSettings)[])
        if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k])
            (_settings as any)[k] = raw[k]
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
        const dir = `${GLib.get_home_dir()}/.config/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(SETTINGS_FILE, JSON.stringify(barSettings, null, 2))
    } catch (e) {
        console.error("[BarSettings] Failed to persist:", e)
    }
    _listeners.forEach(fn => fn(barSettings))
}
