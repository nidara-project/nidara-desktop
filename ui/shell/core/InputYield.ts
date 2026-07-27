import GObject from "gi://GObject"
import GLib from "gi://GLib"
import hyprlandState from "./HyprlandState"

/**
 * INPUT YIELD — the shell stepping out of the way so computer-use can reach a
 * real window.
 *
 * The problem it solves is not ours to argue with, it is in the compositor.
 * `CFocusState::rawWindowFocus` (Hyprland 0.56, FocusState.cpp) returns EARLY
 * while any layer surface holds an EXCLUSIVE keyboard grab:
 *
 *     if (!g_pInputManager->m_exclusiveLSes.empty()) {
 *         Log::logger->log(Log::DEBUG, "Refusing a keyboard focus to a window
 *                                       because of an exclusive ls");
 *         return;
 *     }
 *
 * So while the Assistant island (or Prism, or the app grid) holds the keyboard,
 * `focusWindow` is a NO-OP — not a slow move, not a lie from `hyprctl
 * activewindow`, simply refused. The helpers' "refused: X is not the focused
 * window" was the guard reporting the truth. And Hyprland routes the POINTER to
 * an exclusive-grabbing surface too, regardless of its input region, so the
 * island — which spans the whole monitor — swallowed synthetic clicks before
 * they could reach the app underneath.
 *
 * Together that made every pointer/keyboard verb structurally dead from inside
 * the Assistant, which is the one place they exist for. (AT-SPI perception and
 * named actions were unaffected: they never look at focus.)
 *
 * The fix is a scoped, per-action truce. `begin()` asks every grabbing surface
 * to drop to NONE and stamp an empty input region, waits for the compositor to
 * ANNOUNCE the release (it is double-buffered — see `afterGrabRelease`), and
 * only then lets the caller act; `end()` gives the grab back. It is driven from
 * the HELPERS via the `yieldInput` IPC rather than from the agent daemon, so an
 * external MCP client acting while the user happens to have Prism or the app
 * grid open is covered by the same mechanism.
 */

// A helper that dies between begin() and end() must not leave the shell
// keyboard-less and click-through forever. Every begin() re-arms this; it is a
// crash net, not a duration budget — no legitimate single action is near it.
const WATCHDOG_MS = 15_000

class InputYieldClass extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraInputYield",
            Properties: {
                "active": GObject.ParamSpec.boolean(
                    "active", "Active", "A shell surface has stepped out of the way for an agent action",
                    GObject.ParamFlags.READABLE, false),
            },
        }, this)
    }

    private _active = false
    private _depth = 0
    private _watchdog = 0

    /** Surfaces that CAN hold an EXCLUSIVE grab report whether they hold one right
     *  now. Without this, every action would pay the release wait even with nothing
     *  open — the common case for an external MCP client. */
    private _holders = new Set<() => boolean>()

    /** True while surfaces should keep their hands off the keyboard and pointer.
     *  Grab/input-region sync paths consult this; they must treat it as an override
     *  that wins over their own open/closed state. */
    public get active() { return this._active }

    /** Register a "do I hold the keyboard right now?" predicate. Called before the
     *  surfaces are told to let go, so it must report the state they are IN, not the
     *  one they are about to take. */
    public registerHolder(held: () => boolean) {
        this._holders.add(held)
    }

    /** Step aside. Resolves once the compositor has actually applied the release —
     *  acting before that is the bug this whole module exists to prevent. Re-entrant:
     *  overlapping actions share one truce and the LAST `end()` restores it. */
    public begin(): Promise<void> {
        this._depth++
        this._armWatchdog()
        if (this._active) return Promise.resolve()

        // Nothing is grabbing: no release to wait for, and no reason to make every
        // action pay 80 ms. Stay inactive so `end()` has nothing to undo either.
        let held = false
        for (const h of this._holders) {
            try { if (h()) { held = true; break } } catch (e) { console.error("[InputYield] holder:", e) }
        }
        if (!held) return Promise.resolve()

        this._active = true
        this.notify("active")   // surfaces drop to NONE + stamp an empty region here
        return new Promise<void>(resolve => hyprlandState.afterGrabRelease(() => resolve()))
    }

    /** Take the keyboard back. Safe to call when not yielded (a helper that refused
     *  before ever yielding still runs its cleanup). */
    public end() {
        if (this._depth > 0) this._depth--
        if (this._depth > 0) return
        this._clearWatchdog()
        if (!this._active) return
        this._active = false
        this.notify("active")
    }

    private _armWatchdog() {
        this._clearWatchdog()
        this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
            this._watchdog = 0
            console.warn(`[InputYield] no end() after ${WATCHDOG_MS} ms — a helper died mid-action; restoring`)
            this._depth = 0
            if (this._active) { this._active = false; this.notify("active") }
            return GLib.SOURCE_REMOVE
        })
    }

    private _clearWatchdog() {
        if (this._watchdog) { GLib.source_remove(this._watchdog); this._watchdog = 0 }
    }
}

export const inputYield = new InputYieldClass()
export default inputYield
