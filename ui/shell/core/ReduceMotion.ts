import Gio from "gi://Gio"
import { settings } from "./CompositorState"

/**
 * Reduce motion — the desktop-wide "stop moving things" switch.
 *
 * ## Why this reads a GNOME gsetting instead of a nidara-*.json
 *
 * `org.gnome.desktop.interface enable-animations` already exists, already
 * persists in dconf, and GTK already honours it for the animations INSIDE
 * applications (it lands on `gtk-enable-animations`). A Nidara-owned copy could
 * only ever disagree with it, and one switch that reaches both the desktop and
 * the apps is the whole point of the setting — this is the same reasoning that
 * removed the shadowed Do-Not-Disturb flag (see `state-and-ipc.md`).
 *
 * Settings → Accessibility used to WRITE this key and nothing else. Nothing in
 * the shell read it, so the desktop's own motion — every overlay pop, the dock's
 * springs, the island's morph, every window and workspace animation the compositor
 * draws — carried on regardless. The switch changed apps and left the desktop
 * alone, which is the opposite of what a reader of an accessibility page
 * assumes. This module is the missing reader.
 *
 * ## The polarity
 *
 * The gsetting is `enable-animations` (true = animate). The UI is "Reduce
 * motion" (true = do not animate), because that is what GNOME and CSS
 * (`prefers-reduced-motion`) all call it, and because an accessibility control
 * should be phrased as the accommodation it grants. Everything below is in
 * REDUCE terms; the inversion happens here, once.
 *
 * ## What it does NOT turn off, on purpose
 *
 * - **User-driven motion**: a swipe that follows your finger, a slider thumb
 *   that follows the pointer. Reduce motion is about movement the system starts
 *   on its own; direct manipulation that stops when you stop is not that, and
 *   freezing it would just make the desktop feel broken.
 * - **The Assistant's pointer** (`surfaces/agent-pointer/`). That animation is
 *   not decoration — it is the only way to see where an agent is about to click,
 *   and the user can abort during it. Removing it removes a safety affordance.
 */

const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

// Cached, because the hot readers are a per-frame spring integrator and every
// overlay reveal. `Gio.Settings.get_boolean` hits dconf's cache rather than the
// disk, but a frame callback should not be asking a settings object anything.
let _reduce = !iface.get_boolean("enable-animations")

const _listeners = new Set<(v: boolean) => void>()

/** True when the user has asked for as little movement as possible. */
export const reduceMotion = (): boolean => _reduce

/** Flip the desktop-wide switch. `true` = reduce (i.e. `enable-animations` false). */
export function setReduceMotion(v: boolean) {
    try { iface.set_boolean("enable-animations", !v) } catch (e) {
        console.error("[ReduceMotion] enable-animations:", e)
    }
}

export function onReduceMotionChange(fn: (v: boolean) => void): () => void {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
}

/**
 * Called once from `app.ts` main(). Tells the compositor (a separate process: it restarts,
 * reloads its config, and has no idea what dconf says) and keeps watching.
 *
 * The compositor's animations — window open/close, workspace switches, the layer fades
 * under every panel — are the single biggest piece of motion on the screen, and the one the
 * shell cannot reach by editing its own widgets. Turning reduce motion OFF restores what the
 * compositor's OWN config asks for, never a hard-coded "on", and a config reload that
 * forgets the shell's choice gets it back: both are the backend's
 * (`settings.setReduceMotion`, core/hyprland-settings.ts). Hyalo draws no animation yet.
 */
export function initReduceMotion() {
    settings.setReduceMotion(_reduce)
    iface.connect("changed::enable-animations", () => {
        const v = !iface.get_boolean("enable-animations")
        if (v === _reduce) return
        _reduce = v
        settings.setReduceMotion(v)
        _listeners.forEach(fn => fn(v))
    })
}
