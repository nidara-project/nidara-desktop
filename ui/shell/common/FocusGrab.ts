import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import hs from "../core/HyprlandState"
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
 * Escape hatch. `NIDARA_FOCUS_GRAB=0` makes every `acquire` refuse.
 *
 * ⚠️ It is NOT a fallback any more — there is nothing left to fall back TO. Since
 * the catchers were deleted (2026-08-05) this leaves the shell with no modality at
 * all: panels do not dismiss on an outside click and Prism, the app grid and the
 * island's keyboard modes cannot be typed into. Every surface says so on stderr.
 *
 * It still earns its keep for exactly one failure: a grab that STICKS leaves a
 * surface eating input the user cannot dismiss, and a desktop you can dismiss
 * nothing on still beats one you can do nothing on. `systemctl --user
 * set-environment` is reachable from a TTY when the session is not.
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
                console.error("[FocusGrab] compositor has no hyprland-focus-grab-v1 — NOTHING will dismiss on an outside click. The catchers that used to cover this are gone (2026-08-05): the protocol is now a hard requirement.")
                return
            }
            // The shell and libnidara-wl ship together, but they are installed
            // separately (install.sh §6 / the PKGBUILD), so a checkout rebuilt without
            // reinstalling the library is a real state — and the symptom would be a
            // TypeError deep inside a grab rather than an honest degrade. Verify the
            // whole surface we use, not just that the module loaded.
            if (typeof wl.focus_grab_add_surface !== "function") {
                console.error("[FocusGrab] libnidara-wl is OLDER than this shell — reinstall it (install.sh §6). Until then nothing will dismiss on an outside click: the catchers are gone.")
                return
            }
            shim = wl
            console.log("[FocusGrab] libnidara-wl ready")
        })
        .catch(e => console.error(`[FocusGrab] libnidara-wl unavailable — outside-click dismissal is DEAD without it: ${e}`))
}

/** Start using the shim. Safe to call more than once; also runs on import. */
export function initFocusGrab() { load() }

load()

/** Whether a compositor grab is even possible right now. */
export function hasFocusGrab() { return shim !== null }

/**
 * One caller's claim on the single grab, identified by an opaque token (0 = none).
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
 *      one → nothing dismisses on an outside click, and nothing says why
 *
 * So a lease, and a release that no-ops for anyone but the owner. The eviction in
 * step 2 is real, though, and the evicted owner has to hear about it or it will
 * think it is still modal and never re-acquire — see `acquireFocusGrab`.
 *
 * A lease outlives the grab itself: a popup can take the slot without the owner
 * losing its claim (see `onShimCleared`), which is the `suspended` state below.
 */
type Lease = {
    token: number
    wins: Gtk.Window[]
    onCleared: () => void
    /** While SUSPENDED: the popup that took the slot, and our "closed" handler. */
    popup: Gtk.Popover | null
    popupId: number
}

/** Holding the compositor's grab. */
let held: Lease | null = null
/**
 * Not holding it, but entitled to it back: an xdg-shell popup took the slot and
 * we are waiting for it to close. See `onShimCleared`.
 */
let suspended: Lease | null = null
let nextToken = 1

const surfacesOf = (wins: Gtk.Window[]): Gdk.Surface[] =>
    wins.map(w => w.get_native()?.get_surface() ?? null).filter((s): s is Gdk.Surface => s !== null)

function takeGrab(lease: Lease): boolean {
    const live = surfacesOf(lease.wins)
    if (live.length === 0) return false
    if (!shim!.focus_grab_acquire(live[0], () => onShimCleared(lease))) return false
    for (const s of live.slice(1)) shim!.focus_grab_add_surface(s)
    return true
}

function cancelSuspended(): Lease | null {
    const l = suspended
    if (!l) return null
    if (l.popup && l.popupId) l.popup.disconnect(l.popupId)
    l.popup = null
    l.popupId = 0
    suspended = null
    return l
}

/**
 * A popup that is up right now inside one of `wins`.
 *
 * 🔑 This is the only way to tell the compositor's THREE causes of `cleared`
 * apart, and it is a GTK question rather than a Wayland one: xdg-shell popups
 * take the same single grab slot we do, so a `Gtk.Popover` with `autohide` (the
 * media source menu, GTK's own right-click menu on any `Gtk.Text`) evicts us
 * simply by opening. The protocol tells us nothing about why, but our own widget
 * tree knows whether one is on screen — a popover is a CHILD of the widget it is
 * parented to (verified), so a walk finds it.
 */
function openPopupIn(wins: Gtk.Window[]): Gtk.Popover | null {
    const find = (w: Gtk.Widget): Gtk.Popover | null => {
        for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
            // The cast is the same `Gtk`-is-any-in-value-position gap the rest of the
            // codebase lives with: instanceof against an untyped constructor does not
            // narrow, so tsc still sees a Widget here.
            if (c instanceof Gtk.Popover && (c.get_mapped() || c.get_visible())) return c as Gtk.Popover
            const inner = find(c)
            if (inner) return inner
        }
        return null
    }
    for (const w of wins) {
        const found = find(w)
        if (found) return found
    }
    return null
}

/**
 * The compositor took our grab away. THREE causes, and the protocol does not say
 * which: the user pressed outside (what we asked for), a popup took the slot, or a
 * layer surface mapped asking for keyboard interactivity.
 *
 * We separate the popup case ourselves, because it is the one where closing would
 * be wrong: opening a menu inside a surface must not dismiss the surface the menu
 * belongs to. The island's media source selector and the right-click menu on the
 * assistant's entry both did exactly that. Instead the lease is SUSPENDED and
 * retaken when the popup closes — which is also what let the app grid migrate at
 * all: its context popovers were the one thing keeping it on layer-shell
 * EXCLUSIVE, and suspending is what made a grab survive them (see DockCore).
 */
/**
 * Our machinery just ended up holding nothing. Make sure the desktop still has a
 * focused window: dropping a grab hands the keyboard to whatever the POINTER is
 * over, which is nobody when it rests on the wallpaper — see
 * `HyprlandState.restoreFocusAfterGrab` for the measurement and the two guards.
 *
 * Here rather than in each caller because it is a property of the grab itself: any
 * surface that takes input away owes it back, whichever way it lets go.
 */
function repairFocusIfUnheld() {
    if (held || suspended) return   // somebody still owns input; nothing was handed back
    hs.restoreFocusAfterGrab()
}

function onShimCleared(lease: Lease) {
    if (held?.token !== lease.token) return   // stale: a grab we had already lost
    held = null

    const popup = openPopupIn(lease.wins)
    if (popup) {
        lease.popup = popup
        lease.popupId = popup.connect("closed", () => onPopupClosed(lease))
        suspended = lease
        return
    }
    lease.onCleared()
    repairFocusIfUnheld()
}

function onPopupClosed(lease: Lease) {
    if (suspended?.token !== lease.token) return
    cancelSuspended()
    // Somebody else legitimately took the slot while the popup was up, so we did
    // lose input after all — tell the owner now, late but honestly.
    if (held) { lease.onCleared(); return }
    if (takeGrab(lease)) held = lease
    else lease.onCleared()
}

/**
 * Restrict keyboard and pointer to `wins` — a SET, not one window.
 *
 * 🔑 Pass every window of ours that must stay clickable, not just the modal one.
 * On an outside press the compositor delivers the button to whatever holds pointer
 * focus — and the grab CLAMPS pointer focus to itself — and only then clears. So a
 * press outside dismisses and does nothing else: it never reaches the thing you
 * clicked. A window left out of the set is not "still reachable, merely not modal",
 * it is unreachable in one click. That is why the bar and the island each pass the
 * other: their capsules live on different surfaces.
 *
 * Windows rather than surfaces, for two reasons: `win.get_native()?.get_surface()`
 * comes back UNTYPED from the GIR, so passing a bare surface where the set was
 * expected once type-checked cleanly and threw at runtime; and the widget tree is
 * what lets us tell a popup eviction from a dismissal (see `openPopupIn`).
 *
 * `onCleared` means "I no longer hold input" — never "the user dismissed me". The
 * popup case is handled here and does NOT reach it; what remains is an outside
 * press or an eviction, and for both the honest answer is usually to close. It
 * does not fire for a `releaseFocusGrab()` we asked for.
 *
 * Returns 0 when the grab did not take (no shim, or the first window is not mapped
 * yet), otherwise an ownership token for `releaseFocusGrab`. The caller MUST fall
 * back on 0 — a 0 with no fallback is a surface that silently cannot be typed
 * into. An EXTRA window failing to join does not fail the grab: what degrades is
 * one-click reach elsewhere, not modality.
 *
 * Acquiring while someone else holds EVICTS them, here as in the compositor, and
 * their `onCleared` is invoked once this grab is established — an owner left
 * believing it is still modal would never re-acquire.
 */
export function acquireFocusGrab(wins: (Gtk.Window | null)[], onCleared: () => void): number {
    if (!shim) return 0
    if (!Array.isArray(wins)) wins = [wins as Gtk.Window | null]
    const live = wins.filter((w): w is Gtk.Window => w !== null)
    if (live.length === 0) return 0

    const lease: Lease = { token: nextToken++, wins: live, onCleared, popup: null, popupId: 0 }
    const ok = takeGrab(lease)
    // The shim drops the live grab BEFORE creating the new one, so a failure can
    // mean either "refused before touching it" (our window is not mapped yet — the
    // holder still holds) or "dropped it, then failed". Ask, rather than guess.
    if (!ok && shim.focus_grab_active()) return 0

    const evicted = [held, cancelSuspended()].filter((l): l is Lease => l !== null)
    held = ok ? lease : null
    // Told AFTER the new state is in place, so a release() from inside the handler
    // finds a token mismatch and cannot take down the grab we just took. Skipped for
    // the same owner re-acquiring: it would be telling a surface to dismiss itself
    // for the grab it just asked for.
    for (const l of evicted) if (l.onCleared !== onCleared) l.onCleared()
    return ok ? lease.token : 0
}

/**
 * Hand input back. `token` is what `acquireFocusGrab` returned.
 *
 * A stale token is a NO-OP, deliberately and load-bearing: it is how the loser of
 * an eviction stops destroying the winner's grab. Callers can therefore release
 * unconditionally on close without tracking who won — including while a popup has
 * us suspended, which cancels the pending re-acquire rather than leaking a grab
 * onto a surface the caller has since closed.
 */
export function releaseFocusGrab(token: number) {
    if (!token) return
    if (suspended?.token === token) { cancelSuspended(); return }
    if (held?.token !== token) return
    held = null
    shim?.focus_grab_release()
    repairFocusIfUnheld()
}
