// Hooks — the shell's side of the user hook contract.
//
// `~/.config/nidara/hooks/<event>.d/*` holds executables the user wrote. We
// announce events; `bin/nidara-hook` decides what running them means (order,
// timeout, failure isolation) and IT owns the event table. Nothing here
// enumerates events, on purpose: one list, in the runner, checked by
// `scripts/ci/hook-events-check.mjs` against the `fireHook(…)` call sites.
//
// Why spawn a helper instead of iterating the directory here:
//
//   - `nidara-update` is a bash script and fires `update-completed` from
//     outside this process. One implementation of "run the user's scripts" is
//     the only way both callers agree about ordering and timeouts — the repo
//     already pays for a CI check (`same-app-check`) because four copies of one
//     helper drifted.
//   - a hook is arbitrary user code that can block for its full timeout. It must
//     never be able to sit on the shell's main loop, and a spawned child cannot.
//
// ⚠️ These children inherit the shell's systemd cgroup (`nidara.service`), so a
// hook that starts something long-lived loses it at the next UI reload. That is
// the hook author's problem to solve (`systemd-run --user`), and it is
// documented in the runner's header — but it is the reason not to "helpfully"
// keep a handle on them here.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import * as battery from "./BatteryService"

let runnerMissingReported = false

/**
 * Announce a desktop event to the user's hooks. Fire-and-forget: never awaits,
 * never throws, and a desktop with no hooks pays one short-lived process.
 *
 * The event name MUST exist in the table in `bin/nidara-hook`; CI enforces it.
 */
export function fireHook(event: string, ...args: string[]): void {
    try {
        // Flags.NONE: the hook's stdout/stderr are ours, so `console.log` in a
        // user's script lands in the shell log next to everything else. That is
        // the only debugging channel a hook author has.
        const proc = Gio.Subprocess.new(["nidara-hook", event, ...args], Gio.SubprocessFlags.NONE)
        // Reaped by GSubprocess's own child watch; asked for explicitly so the
        // object stays referenced until the child is gone.
        proc.wait_async(null, null)
    } catch (e) {
        // The one expected failure is a dev checkout whose `install.sh` predates
        // this binary — /usr/bin/nidara-hook simply is not there yet. Say it once:
        // every accent nudge would otherwise repeat it.
        if (!runnerMissingReported) {
            runnerMissingReported = true
            console.error(`[Hooks] could not run nidara-hook (${event}) — re-run install.sh:`, e)
        }
    }
}

/**
 * `session-started`, exactly once per login session.
 *
 * main() runs on every UI RELOAD, not just at login (the same trap the DnD
 * seeding block in app.ts was deleted for). A stamp in the runtime dir is what
 * makes the event mean what its name says: $XDG_RUNTIME_DIR is created with the
 * user's first session and destroyed with their last, so the file cannot outlive
 * the session that made it, and no cleanup of ours is needed.
 */
export function fireSessionStartedOnce(): void {
    const stamp = `${GLib.get_user_runtime_dir()}/nidara-session-started`
    if (GLib.file_test(stamp, GLib.FileTest.EXISTS)) return
    try {
        GLib.file_set_contents(stamp, "")
    } catch (e) {
        // Unwritable runtime dir: fire anyway. Announcing twice after a reload is
        // a smaller failure than a desktop where the event never happens.
        console.warn("[Hooks] session stamp unwritable:", e)
    }
    fireHook("session-started")
}

// ── battery-low ──────────────────────────────────────────────────────────────
// The only event with no natural firing site: nothing in the shell "decides" a
// battery is low, so the crossing has to be detected here.

const LOW = 20   // fires at or below this, while discharging
const REARM = 25 // …and cannot fire again until it comes back above this

/**
 * Watch the battery and fire `battery-low` on a downward crossing.
 *
 * Armed from the CURRENT level rather than optimistically: a shell started (or
 * reloaded) on an already-flat laptop must not announce a crossing it did not
 * see. It stays disarmed until the battery is charged past REARM or put on AC,
 * which is also what keeps one discharge from firing twice while the reading
 * jitters around the threshold.
 */
export function initBatteryLowHook(): void {
    if (!battery.present()) return

    let armed = Math.round(battery.fraction() * 100) > LOW

    battery.watch(() => {
        if (!battery.present()) return
        const pct = Math.round(battery.fraction() * 100)
        const onPower = battery.charging() || battery.charged()

        if (!armed) {
            if (onPower || pct >= REARM) armed = true
            return
        }
        if (!onPower && pct <= LOW) {
            armed = false
            fireHook("battery-low", String(pct))
        }
    })
}
