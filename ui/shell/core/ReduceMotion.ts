import Gio from "gi://Gio"
import hs from "./HyprlandState"

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
 * springs, the island's morph, every window and workspace animation Hyprland
 * draws — carried on regardless. The switch changed apps and left the desktop
 * alone, which is the opposite of what a reader of an accessibility page
 * assumes. This module is the missing reader.
 *
 * ## The polarity
 *
 * The gsetting is `enable-animations` (true = animate). The UI is "Reduce
 * motion" (true = do not animate), because that is what GNOME, macOS and CSS
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
 * What `animations:enabled` was BEFORE the shell ever touched it — i.e. what the
 * user's own config asks for.
 *
 * 🔑 Turning reduce motion OFF must restore this, not hardcode `true`. Nidara's
 * shipped `hyprland.lua` enables animations, but `hyprland-user.lua` is the user's
 * to override, and a shell that writes `enabled = true` at every boot would
 * silently overrule someone who turned them off there — a settings page reaching
 * back into a config file it does not own. Read once, before the first push.
 */
let _hyprBaseline = true

/**
 * Hyprland's master animation switch.
 *
 * ⚠️ `hl.config`, NOT `hyprctl keyword`. Nidara configures Hyprland in Lua and
 * that parser answers `keyword` with "Use eval." — a refusal that costs nothing
 * and changes nothing, so a `keyword` call here would look like it worked. The
 * shape below is the one the shipped API stub declares
 * (`/usr/share/hypr/stubs/hl.meta.lua`: `HL.ConfigOpt.Animations.enabled`), and
 * the result is observable with `hyprctl getoption animations:enabled`.
 *
 * This is the single biggest piece of motion on the screen — window open/close,
 * workspace switches, the layer fades under every panel — and the one the shell
 * cannot reach by editing its own widgets.
 */
function pushToHyprland(reduce: boolean) {
    const on = reduce ? false : _hyprBaseline
    hs.evalLua(`hl.config({ animations = { enabled = ${on} } })`)
}

/**
 * Called once from `app.ts` main(). Applies the current value to Hyprland (the
 * compositor is a separate process: it restarts, reloads its config, and has no
 * idea what dconf says) and keeps watching.
 */
export function initReduceMotion() {
    // ⚠️ Only trust the LIVE option as the baseline when we are not currently
    // reducing. The shell can be reloaded (Super+Shift+R) while reduce motion is
    // on, and the compositor keeps what the previous instance pushed — so reading
    // it then would capture OUR `false` as "what the user wants" and pin
    // animations off for good. When reducing at startup we assume the shipped
    // default instead, and the reload handler below corrects it the moment
    // Hyprland actually re-reads its config (which discards our eval, making the
    // live value the config's value again).
    _hyprBaseline = _reduce ? true : hs.getOptionBool("animations:enabled", true)
    // Nothing to say to the compositor when we are not reducing: it is already
    // showing whatever its own config asked for, and the point of the baseline is
    // to not overwrite that with our idea of the default.
    if (_reduce) pushToHyprland(true)
    iface.connect("changed::enable-animations", () => {
        const v = !iface.get_boolean("enable-animations")
        if (v === _reduce) return
        _reduce = v
        pushToHyprland(v)
        _listeners.forEach(fn => fn(v))
    })
    // A `hyprctl reload` (or an edit to hyprland-user.lua) re-reads the config
    // file, where `animations` is enabled — so the compositor silently forgets we
    // asked. Re-assert, and re-read the baseline from the config that just loaded
    // so an edit to hyprland-user.lua is still the user's last word.
    hs.connect("config-reloaded", () => {
        _hyprBaseline = hs.getOptionBool("animations:enabled", true)
        if (_reduce) pushToHyprland(true)
    })
}
