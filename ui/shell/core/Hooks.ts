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
import { spawn } from "../../lib/process"

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
        const proc = spawn(["nidara-hook", event, ...args], Gio.SubprocessFlags.NONE)
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
 * makes the event mean what its name says — but the runtime dir alone is NOT a
 * login: with lingering on (`loginctl enable-linger`) it outlives every logout,
 * and a stamp that only had to exist swallowed every login after the first one
 * since boot. So the stamp counts only when it is newer than the compositor's
 * display socket, which each login creates afresh and a UI reload never touches.
 */
export function fireSessionStartedOnce(): void {
    const runtime = GLib.get_user_runtime_dir()
    const stamp = `${runtime}/nidara-session-started`
    const display = GLib.getenv("WAYLAND_DISPLAY")
    const stamped = mtime(stamp)
    if (stamped > 0 && stamped >= (display ? mtime(`${runtime}/${display}`) : 0)) return
    try {
        GLib.file_set_contents(stamp, "")
    } catch (e) {
        // Unwritable runtime dir: fire anyway. Announcing twice after a reload is
        // a smaller failure than a desktop where the event never happens.
        console.warn("[Hooks] session stamp unwritable:", e)
    }
    fireHook("session-started")
}

/** A file's modification time in µs, or 0 when it cannot be read. */
function mtime(path: string): number {
    try {
        const info = Gio.File.new_for_path(path).query_info("time::modified,time::modified-usec", Gio.FileQueryInfoFlags.NONE, null)
        return info.get_attribute_uint64("time::modified") * 1e6 + info.get_attribute_uint32("time::modified-usec")
    } catch {
        return 0
    }
}
