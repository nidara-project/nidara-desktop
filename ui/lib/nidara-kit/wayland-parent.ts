// SPDX-License-Identifier: LGPL-3.0-or-later
import Gtk from "gi://Gtk?version=4.0"
// ⚠️ Load-bearing import, same trap as ui/lib/nidara-kit/platform/app-id.ts: without the GdkWayland
// typelib loaded, GJS sees the surface as a bare GdkSurface and
// `set_transient_for_exported` does not exist on it.
import "gi://GdkWayland?version=4.0"

/**
 * Make `win` a child of a window that belongs to ANOTHER process.
 *
 * An XDG portal hands a backend the requesting app's window as a string:
 * `wayland:<handle>` (a zxdg_exporter_v2 token) or `x11:<xid>`. A dialog shown for
 * that request has to sit on top of that window and move with it — otherwise it
 * opens loose somewhere on screen and the user cannot tell which app is asking,
 * which for a CONSENT prompt is the whole point.
 *
 * Measured 2026-09-13 in a nested Hyprland (study DIALOGOS T3): Hyprland exposes
 * `zxdg_importer_v2`, `set_transient_for_exported()` returns true from GJS, and the
 * compositor centres the child over the parent. Without it the dialog tiles like any
 * toplevel.
 *
 * `x11:` parents and empty strings are ignored (returns false): an XWayland window
 * cannot be a Wayland parent, and a request with no window is legitimate.
 */
export function setTransientForExported(win: Gtk.Window, parentWindow: string | null | undefined): boolean {
    const m = /^wayland:(.+)$/.exec(parentWindow ?? "")
    if (!m) return false
    const handle = m[1]
    let applied = false
    const apply = (): void => {
        const surface = win.get_surface() as any
        if (!surface || typeof surface.set_transient_for_exported !== "function") {
            console.warn(`[wayland-parent] ${surface?.constructor?.name ?? "no surface"} cannot take an exported parent`)
            return
        }
        try {
            applied = surface.set_transient_for_exported(handle) === true
            if (!applied) console.warn(`[wayland-parent] compositor rejected parent handle "${handle}"`)
        } catch (e) {
            console.warn("[wayland-parent] set_transient_for_exported failed:", e)
        }
    }
    // The surface exists from realize; the transient relation must be in place
    // before the first map, or the compositor has already placed the window.
    if (win.get_realized()) apply()
    else win.connect("realize", apply)
    return true
}
