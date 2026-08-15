import GObject from "gi://GObject"
import GLib from "gi://GLib"
import hyprlandState from "./HyprlandState"

/**
 * INPUT YIELD — the shell stepping out of the way so computer-use can reach a
 * real window.
 *
 * ⚠️ THIS MODULE SURVIVED THE FOCUS-GRAB MIGRATION, but its reason changed. Read
 * the current one first; the history below explains why it is still here at all.
 *
 * WHY IT IS STILL NEEDED. A `hyprland-focus-grab-v1` grab CLAMPS POINTER FOCUS to
 * the grabbed surface: the holder receives every press regardless of input
 * regions (that clamp is exactly what buys us outside-click dismissal — see
 * `common/FocusGrab.ts`). So while the Assistant island holds a grab — and it
 * holds one for EVERY open mode, not just the typing ones — a synthetic click
 * aimed at an app underneath lands on the island instead. The island spans the
 * whole monitor, so there is nowhere for such a click to get through.
 *
 * WHAT IT USED TO BE, AND WHY THAT MATTERED MORE. Under layer-shell EXCLUSIVE the
 * same surfaces also broke window focus outright:
 * `CFocusState::rawWindowFocus` (Hyprland 0.56, FocusState.cpp) returns EARLY
 * while any layer surface is in `m_exclusiveLSes` ("Refusing a keyboard focus to
 * a window because of an exclusive ls"), so `focusWindow` was a NO-OP — not a
 * slow move, not a lie from `hyprctl activewindow`, simply refused. The helpers'
 * "refused: X is not the focused window" was the guard reporting the truth. A
 * focus grab drives `rawSurfaceFocus` instead and does NOT refuse focus moves, so
 * that half of the problem is gone; the pointer clamp above is what remains.
 * ⚠️ Do not read the fix below as EXCLUSIVE-era leftovers: no shell surface asks
 * for EXCLUSIVE any more, and re-introducing one would bring the refusal back.
 *
 * Either way, this made every pointer/keyboard verb structurally dead from inside
 * the Assistant, which is the one place they exist for. (AT-SPI perception and
 * named actions were unaffected: they never look at focus.)
 *
 * The fix is a scoped, per-action truce. `begin()` asks every grabbing surface to
 * RELEASE its focus grab and stamp an empty input region, waits for the
 * compositor to ANNOUNCE the release (see `afterGrabRelease`), and only then lets
 * the caller act; `end()` gives the grab back. It is driven from the HELPERS via
 * the `yieldInput` IPC rather than from the agent daemon, so an external MCP
 * client acting while the user happens to have Prism or the app grid open is
 * covered by the same mechanism.
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

    /** Surfaces that CAN hold a focus grab report whether they hold one right now.
     *  Without this, every action would pay the release wait even with nothing
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

        // Read BEFORE the notify: this is the last moment the answer is still the
        // caller's. See `_restoreFocus` for what happens to it a few milliseconds later.
        const keep = (hyprlandState.focusedClient as any)?.address ?? ""

        this._active = true
        this.notify("active")   // surfaces release their grab + stamp an empty region here
        return new Promise<void>(resolve => hyprlandState.afterGrabRelease(() =>
            this._restoreFocus(keep).then(() => resolve())))
    }

    /**
     * Hand the keyboard back to whoever had it before we stepped aside.
     *
     * 🔑 THE YIELD ITSELF CAN TAKE THE FOCUS AWAY. Dropping a focus grab makes Hyprland
     * refocus on its own, and `input:follow_mouse` picks how: `1` → BY POINTER, wherever
     * the user last left it; `0 || 2 || 3` → the monitor's last window, which after a
     * `focusWindow` is the target we want. `config/hypr/hyprland.lua` shipped `1` when
     * this was written and ships `2` since 2026-08-15 — so the default install is now
     * the harmless branch, and this stays because a user override is one
     * `hyprland-user.lua` line and re-focusing the right window costs nothing when the
     * compositor already chose it. Measured 2026-08-12 (under `1`): the model
     * called `focusWindow org.gnome.TextEditor`, the compositor confirmed it by title,
     * and 3.2 s later the click was refused because the active window was the terminal
     * the cursor happened to sit over. The desktop had undone the caller's own
     * precondition, and then blamed the caller for it.
     *
     * The `activewindow` event `afterGrabRelease` waits for IS that wrong focus
     * arriving, so this runs at exactly the right instant — no delay to tune.
     *
     * ⚠️ NOT the same policy as `restoreFocusAfterGrab`, which returns early when
     * "the compositor found someone". That is right for a dismissal: whatever the
     * pointer is over is a fine answer when the user just clicked something away.
     * It is wrong here, because a computer-use caller has ALREADY chosen the window
     * and the helpers verify focus before they inject.
     *
     * Dispatched unconditionally rather than only when the focus moved: re-focusing
     * the window that is already focused is a compositor no-op, whereas deciding
     * would mean reading `focused_client` in the middle of the event that changes it.
     * We wait for `hyprctl` to EXIT, not merely to be spawned — the helper's own
     * `hyprctl activewindow` is a separate process and must not race ours.
     */
    private _restoreFocus(keep: string): Promise<unknown> {
        if (!keep) return Promise.resolve()   // nothing was focused; nothing to give back
        return Promise.resolve(hyprlandState.focusWindow(keep))
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
