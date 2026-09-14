import GLib from "gi://GLib"
import { defineSettings } from "../../core/configFile"
import { SHELL_ROOT } from "../../core/Paths"

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
export const barConfig = defineSettings("bar", DEFAULTS)

export const barSettings: BarSettings = barConfig.all as BarSettings

export function onBarSettingsChanged(fn: (s: BarSettings) => void): () => void {
    return barConfig.subscribeAll(() => fn(barSettings))
}

export function updateBarSettings(partial: Partial<BarSettings>) {
    barConfig.update(partial)
}


// The launcher mark's catalogue lives HERE, beside the setting it resolves, and not in
// Bar.tsx: Settings reads it too, and importing it from Bar.tsx pulled the whole bar —
// the Control Centre, the island, Prism, the notification server — into anything that
// builds the Settings page (#571).
export const LAUNCHER_ICON_PRESETS: Record<string, string> = {
    "nidara": `${SHELL_ROOT}/assets/nidara/assets/nidara-symbolic.svg`,
}

export const DEFAULT_LAUNCHER_ICON = "nidara"

/** A preset key or an image path that still exists → its file; anything else → null. */
export function resolveLauncherIcon(key: string): string | null {
    if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
    if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
    return null
}
