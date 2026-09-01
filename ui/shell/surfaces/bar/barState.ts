import { defineConfig } from "../../core/configFile"

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
export const barConfig = defineConfig("bar-settings.json", DEFAULTS)

export const barSettings: BarSettings = barConfig.all as BarSettings

export function onBarSettingsChanged(fn: (s: BarSettings) => void): () => void {
    return barConfig.subscribeAll(() => fn(barSettings))
}

export function updateBarSettings(partial: Partial<BarSettings>) {
    barConfig.update(partial)
}

