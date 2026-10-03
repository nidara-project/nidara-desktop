// Runs night light: the schedule (#571), and the compositor's warmth through
// `settings.setNightLight` — hyprsunset on Hyprland, Hyalo's own gamma ramps on Hyalo.
//
// ⚠️ SHELL ONLY — started from app.ts, like GameSession and AppearanceHooks. It reacts to
// org.nidara.night-light, so a change from any writer applies exactly once: the Settings
// window, the CC tile, an agent's setConfig, or `gsettings set` in a terminal (which,
// before this module, flipped the switch and left the screen as it was).
//
// It is also the ONE process that writes `enabled` on its own — when the schedule
// crosses a boundary. A second process running a schedule timer would race it.

import GLib from "gi://GLib"
import NightLight, { isInSchedule } from "./NightLightManager"
import { settings } from "./CompositorState"

let started = false
let warm = false
let scheduleTimer = 0

function warmUp(): void {
    settings.setNightLight(NightLight.temperature)
    warm = true
}

function kill(): void {
    if (!warm) return
    settings.setNightLight(null)
    warm = false
}

/** The schedule decides `enabled`. Writing it is enough: the `enabled` subscriber below
 *  warms the screens or puts them back. */
function checkSchedule(): void {
    const inWindow = isInSchedule(NightLight.scheduleFrom, NightLight.scheduleTo)
    if (inWindow !== NightLight.enabled) NightLight.setEnabled(inWindow)
}

function syncScheduleTimer(): void {
    if (NightLight.scheduleEnabled) {
        checkSchedule()
        if (scheduleTimer === 0) {
            scheduleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60_000, () => {
                checkSchedule()
                return GLib.SOURCE_CONTINUE
            })
        }
    } else if (scheduleTimer > 0) {
        GLib.source_remove(scheduleTimer)
        scheduleTimer = 0
    }
}

/** Idempotent: a second call does nothing. */
export function startNightLightSync(): void {
    if (started) return
    started = true

    NightLight.subscribe("enabled", () => { if (NightLight.enabled) warmUp(); else kill() })
    // Every temperature of a slider drag goes through: the compositor decides what it can take
    // (Hyalo coalesces them to one ramp per tick; hyprland-settings.ts waits for hyprsunset).
    NightLight.subscribe("temperature", () => { if (NightLight.enabled) warmUp() })
    NightLight.subscribe("scheduleEnabled", syncScheduleTimer)
    NightLight.subscribe("scheduleFrom", () => { if (NightLight.scheduleEnabled) checkSchedule() })
    NightLight.subscribe("scheduleTo", () => { if (NightLight.scheduleEnabled) checkSchedule() })

    // Start: with a schedule, the clock decides — the saved `enabled` describes whichever
    // half of the schedule we were in when the shell last ran. Then run what it says.
    syncScheduleTimer()
    if (NightLight.enabled && !warm) warmUp()
}
