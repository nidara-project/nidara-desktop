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
    focus_grab_add_surface(surface: Gdk.Surface): boolean
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
            // The shell and libnidara-wl ship together, but they are installed
            // separately (install.sh §6 / the PKGBUILD), so a checkout rebuilt without
            // reinstalling the library is a real state — and the symptom would be a
            // TypeError deep inside a grab rather than an honest degrade. Verify the
            // whole surface we use, not just that the module loaded.
            if (typeof wl.focus_grab_add_surface !== "function") {
                console.log("[FocusGrab] libnidara-wl is older than this shell — reinstall it; using layer-shell grabs")
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
 * Who currently holds the single grab, as an opaque token. 0 = nobody.
 *
 * 🔑 THE ONE GRAB HAS TWO OWNERS. The shim keeps exactly one
 * `hyprland_focus_grab_v1` because the compositor has exactly one slot — but the
 * bar's window and the island's window ask for it INDEPENDENTLY. Without an
 * owner, `release()` destroys *whatever grab exists*, not *the caller's*, and the
 * interleaving that costs you a working desktop is ordinary:
 *
 *   1. an island mode is open, the island holds the grab
 *   2. a bar panel opens; Status closes the island and the bar acquires — which
 *      evicts the island's grab, correctly
 *   3. the island's own notify handler then runs and calls release()
 *   4. …destroying the BAR's brand-new grab, while the bar still believes it holds
 *      one and keeps its catcher hidden → nothing dismisses on an outside click
 *
 * So a token, and a release that no-ops for anyone but the owner. The eviction in
 * step 2 is real, though, and the evicted owner has to hear about it or it will
 * think it is still modal and never re-acquire — see `acquireFocusGrab`.
 */
let heldToken = 0
let heldCleared: (() => void) | null = null
let nextToken = 1

/**
 * Restrict keyboard and pointer to `surfaces` — a SET, not one surface.
 *
 * 🔑 Pass every surface of ours that must stay clickable, not just the one that is
 * modal. On an outside press the compositor delivers the button to whatever holds
 * pointer focus — and the grab CLAMPS pointer focus to itself — and only then
 * clears the grab. So a press outside dismisses and does nothing else: it never
 * reaches the thing you clicked. A surface left out of the set is not "still
 * reachable, merely not modal", it is unreachable in one click. That is why the
 * island grabs the bar's surface alongside its own — capsule-to-capsule switching
 * has to survive without a catcher arranging it.
 *
 * `onCleared` fires when the COMPOSITOR takes the grab away, which happens for
 * three reasons that are indistinguishable from here: the user pressed outside,
 * a popup grab took the slot, or a layer surface mapped asking for keyboard
 * interactivity. Handle it as "I no longer hold input" — close if that is what
 * the surface should do, or re-acquire if it is still meant to be modal. It does
 * NOT fire for a `releaseFocusGrab()` we asked for.
 *
 * Returns 0 when the grab did not take (no shim, or the first surface is not
 * mapped yet), otherwise an ownership token to hand back to `releaseFocusGrab`.
 * The caller MUST fall back on 0 — a 0 with no fallback is a surface that
 * silently cannot be typed into. An EXTRA surface failing to join does not fail
 * the grab: what degrades then is one-click reach elsewhere, not modality.
 *
 * Acquiring while someone else holds the grab EVICTS them, here as in the
 * compositor. The previous owner's `onCleared` is invoked for it, once this
 * grab is established — because from that owner's side losing the slot to us is
 * indistinguishable from losing it to a popup, and it must not be left believing
 * it is still the modal surface (it would never re-acquire).
 */
export function acquireFocusGrab(surfaces: (Gdk.Surface | null)[], onCleared: () => void): number {
    if (!shim) return 0
    // Defended rather than trusted: `win.get_native()?.get_surface()` comes back
    // untyped from the GIR, so tsc will NOT catch a caller that passes a bare
    // surface where the set is expected — it silently typed a crash as fine once.
    if (!Array.isArray(surfaces)) surfaces = [surfaces as Gdk.Surface | null]
    const live = surfaces.filter((s): s is Gdk.Surface => s !== null)
    if (live.length === 0) return 0

    const evicted = heldCleared
    const token = nextToken++
    const ok = shim.focus_grab_acquire(live[0], () => {
        // A `cleared` that arrives for a grab we no longer own is not ours to act
        // on: the shim's callback slot is per-grab, but a stale closure could still
        // be in flight through the pump.
        if (heldToken !== token) return
        heldToken = 0
        heldCleared = null
        onCleared()
    })

    if (ok) {
        heldToken = token
        heldCleared = onCleared
        for (const s of live.slice(1)) shim.focus_grab_add_surface(s)
    } else if (shim.focus_grab_active()) {
        // The shim refused before touching the live grab (our surface is not mapped
        // yet), so the previous owner still holds it and nothing has changed.
        return 0
    } else {
        // It got far enough to drop the old grab and then failed. Nobody holds one.
        heldToken = 0
        heldCleared = null
    }

    // Told AFTER the new state is in place, so a release() from inside the handler
    // finds a token mismatch and cannot take down the grab we just took. Skipped
    // when the same owner re-acquired: it would be telling a surface to dismiss
    // itself for the grab it just asked for.
    if (evicted && evicted !== heldCleared) evicted()
    return ok ? token : 0
}

/**
 * Hand input back. `token` is what `acquireFocusGrab` returned.
 *
 * A stale token is a NO-OP, deliberately and load-bearing: it is how the loser of
 * an eviction stops destroying the winner's grab (see `heldToken`). Callers can
 * therefore release unconditionally on close without tracking who won.
 */
export function releaseFocusGrab(token: number) {
    if (!token || token !== heldToken) return
    heldToken = 0
    heldCleared = null
    shim?.focus_grab_release()
}
