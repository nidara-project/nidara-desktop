import GLib from "gi://GLib"
import type Gdk from "gi://Gdk?version=4.0"

/**
 * Thin wrapper over libnidara-wl's focus-grab API (hyprland-focus-grab-v1).
 *
 * What it buys, and why it is worth a protocol:
 *
 *  - **Keyboard without EXCLUSIVE.** A layer surface normally takes the keyboard
 *    by asking layer-shell for EXCLUSIVE interactivity, which lands it in
 *    Hyprland's `m_exclusiveLSes` — and that list makes the compositor REFUSE to
 *    move window focus at all (`CFocusState::rawWindowFocus`). That refusal is
 *    the entire reason `core/InputYield` exists. A focus grab drives
 *    `rawSurfaceFocus` directly instead, so the surface can stay NONE.
 *  - **Outside-click dismissal, in the compositor.** A press outside the grabbed
 *    surface clears the grab. We no longer need an invisible full-screen button
 *    covering the desktop to notice it, and dismissal now works over regions we
 *    never covered.
 *  - **A release that is not double-buffered.** Layer-shell interactivity applies
 *    on the surface's next commit — the ~12 ms race `afterGrabRelease` was built
 *    to survive. Destroying a grab takes effect when the compositor reads it.
 *
 * Loaded LAZILY and tolerated missing, same contract as `common/VisibleRegion.ts`:
 * absent shim = `acquire()` returns false and the caller keeps its old mechanism.
 * That answer is synchronous, so a caller can decide per-open rather than once.
 *
 * ⚠️ ONE grab exists compositor-wide (`CSeatManager::m_seatGrab`), and xdg-shell
 * popups take the SAME slot. A `Gtk.Popover` with autohide opening anywhere will
 * evict us. See `onCleared` below: it is not a synonym for "the user dismissed
 * this".
 */

type Shim = {
    init(): boolean
    has_focus_grab(): boolean
    focus_grab_acquire(surface: Gdk.Surface, cleared: (() => void) | null): boolean
    focus_grab_release(): void
    focus_grab_active(): boolean
}

const SHIM_MODULE = "gi://NidaraWl"

/**
 * Escape hatch, and the only way to A/B against the old EXCLUSIVE + catcher path
 * without two builds. `NIDARA_FOCUS_GRAB=0` keeps every surface on layer-shell
 * interactivity.
 *
 * It earns its keep because the failure mode is modality: a grab that sticks
 * leaves a surface eating input the user cannot dismiss, and `systemctl --user
 * set-environment` is reachable from a TTY when the desktop is not.
 */
const DISABLED = GLib.getenv("NIDARA_FOCUS_GRAB") === "0"

let shim: Shim | null = null
let loading = false

function load() {
    if (shim || loading) return
    loading = true
    if (DISABLED) {
        console.log("[FocusGrab] disabled by NIDARA_FOCUS_GRAB=0 — layer-shell interactivity")
        return
    }
    // Specifier held in a variable ON PURPOSE — see VisibleRegion.ts for why a
    // literal would turn an optional runtime dependency into a hard typecheck one.
    import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init()) throw new Error("init returned false")
            if (!wl.has_focus_grab()) {
                console.log("[FocusGrab] compositor has no hyprland-focus-grab-v1 — skipping")
                return
            }
            shim = wl
            console.log("[FocusGrab] libnidara-wl ready")
        })
        .catch(e => console.log(`[FocusGrab] unavailable, using layer-shell grabs: ${e}`))
}

/** Start using the shim. Safe to call more than once; also runs on import. */
export function initFocusGrab() { load() }

load()

/** Whether a compositor grab is even possible right now. */
export function hasFocusGrab() { return shim !== null }

/**
 * Restrict keyboard and pointer to `surface`.
 *
 * `onCleared` fires when the COMPOSITOR takes the grab away, which happens for
 * three reasons that are indistinguishable from here: the user pressed outside,
 * a popup grab took the slot, or a layer surface mapped asking for keyboard
 * interactivity. Handle it as "I no longer hold input" — close if that is what
 * the surface should do, or re-acquire if it is still meant to be modal. It does
 * NOT fire for a `releaseFocusGrab()` we asked for.
 *
 * Returns false when the grab did not take (no shim, or the surface is not
 * mapped yet). The caller MUST then fall back — a false here with no fallback is
 * a surface that silently cannot be typed into.
 */
export function acquireFocusGrab(surface: Gdk.Surface | null, onCleared: () => void): boolean {
    if (!shim || !surface) return false
    return shim.focus_grab_acquire(surface, onCleared)
}

/** Hand input back. Safe when nothing is held. */
export function releaseFocusGrab() {
    shim?.focus_grab_release()
}
