// Runs night light: hyprsunset and the schedule (#571).
//
// ⚠️ SHELL ONLY — started from app.ts, like GamingSync and AppearanceHooks. It reacts to
// org.nidara.night-light, so a change from any writer applies exactly once: the Settings
// window, the CC tile, an agent's setConfig, or `gsettings set` in a terminal (which,
// before this module, flipped the switch and left the screen as it was).
//
// It is also the ONE process that writes `enabled` on its own — when the schedule
// crosses a boundary. A second process running a schedule timer would race it.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import NightLight, { isInSchedule } from "./NightLightManager"

let started = false
let proc: Gio.Subprocess | null = null
let respawnDebounce = 0
let scheduleTimer = 0

function spawn(): void {
    kill()
    try {
        proc = Gio.Subprocess.new(["hyprsunset", "-t", String(NightLight.temperature)], Gio.SubprocessFlags.NONE)
    } catch (e) {
        console.error("[NightLight] Failed to start hyprsunset:", e)
        proc = null
    }
}

function kill(): void {
    if (!proc) return
    try { proc.force_exit() } catch (_) {}
    proc = null
}

/** The schedule decides `enabled`. Writing it is enough: the `enabled` subscriber below
 *  starts or stops hyprsunset. */
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

    NightLight.subscribe("enabled", () => { if (NightLight.enabled) spawn(); else kill() })
    // A slider drag writes many temperatures; restart hyprsunset once it settles.
    NightLight.subscribe("temperature", () => {
        if (!NightLight.enabled) return
        if (respawnDebounce > 0) GLib.source_remove(respawnDebounce)
        respawnDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            respawnDebounce = 0
            spawn()
            return GLib.SOURCE_REMOVE
        })
    })
    NightLight.subscribe("scheduleEnabled", syncScheduleTimer)
    NightLight.subscribe("scheduleFrom", () => { if (NightLight.scheduleEnabled) checkSchedule() })
    NightLight.subscribe("scheduleTo", () => { if (NightLight.scheduleEnabled) checkSchedule() })

    // Start: with a schedule, the clock decides — the saved `enabled` describes whichever
    // half of the schedule we were in when the shell last ran. Then run what it says.
    syncScheduleTimer()
    if (NightLight.enabled && !proc) spawn()
}
