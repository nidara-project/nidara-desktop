import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import hs from "../core/HyprlandState"
import { safeDisconnect } from "../core/signals"

/**
 * A new cursor theme or size does not reach the cursor already on screen — the
 * setting appears to arrive only when the pointer leaves the window it was changed
 * from. This puts it on screen immediately.
 *
 * 🔑 **The one law behind all of it: Hyprland redraws the cursor only when it sees a
 * different shape NAME.** Not when the theme is reloaded, not when the cursor is
 * hidden and shown again. `IHyprRenderer::setCursorFromName` (0.56.2, and identical on
 * `main`) opens with `if (name == m_lastCursorData.name && !force) return;`, and
 * `changeTheme()` only reloads the theme and schedules frames — so those frames
 * repaint the OLD picture. Measured, pointer parked and never moved:
 *
 *     Adwaita on screen                  →  112 cursor px
 *     hyprctl setcursor Qogir-Dark       →  112   (the bug)
 *     toggle cursor:invisible off and on →  112   (does NOT repaint)
 *     a crossing that changes the NAME   →  147   (the only thing that does)
 *
 * A name is what `wp_cursor_shape_v1` carries, so this is not a trick: naming the
 * shape again is the protocol's own way of saying "draw the pointer". We bounce
 * through a different shape and straight back, in one main-loop iteration — the
 * compositor applies both in one pass, so the intermediate is never composited and
 * nothing flickers. GDK compares cursors by EQUALITY, so it has to be a different
 * shape; a fresh `Gdk.Cursor` with the same name puts nothing on the wire.
 *
 * ⚠️ **Scope.** Only the client holding pointer focus may name a shape
 * (`InputManager.cpp:68-72`), so this reaches Nidara's surfaces, not third-party apps.
 * The case where nobody holds it — right after a dropdown's popover closes — is handled
 * by `refreshAfterRefocus`; read it, it is the subtlest part of this file.
 *
 * ⚠️ **Never verify this with a screenshot.** See the cursor section of
 * `references/dev-workflow.md`: `grim -c` only refreshes its copy on the pointer-focus
 * path, which is exactly what this avoids needing.
 */
function bump(w: Gtk.Widget) {
    const had = w.get_cursor()
    const via = had?.get_name() === "crosshair" ? "text" : "crosshair"
    w.set_cursor(Gdk.Cursor.new_from_name(via, null))
    w.set_cursor(had)
}

/** Re-issue the cursor on whichever of our surfaces the pointer is in.
 *  Returns false when there was nothing to re-issue it on — see `refreshAfterRefocus`. */
export function refreshShellCursor(): boolean {
    try {
        const pointer = Gdk.Display.get_default()?.get_default_seat()?.get_pointer()
        const [surface, sx, sy] = pointer?.get_surface_at_position() ?? []
        if (!surface) return false

        const native = Gtk.Native.get_for_surface(surface)
        if (!native) return false
        // A dead popover: GDK keeps naming it long after the popup is destroyed, and
        // setting a cursor on an unmapped widget puts nothing on the wire.
        if (!(native as unknown as Gtk.Widget).get_mapped()) return false

        // Surface coordinates are not widget coordinates — a native's widget origin is
        // inset by its shadow, and `pick` wants the latter.
        const [tx, ty] = native.get_surface_transform()
        const root = native as unknown as Gtk.Widget

        // GTK resolves a surface's cursor from the widget under the pointer upwards, so
        // bump whichever widget actually owns it — several Settings rows set their own.
        let owner: Gtk.Widget | null = root.pick(sx - tx, sy - ty, Gtk.PickFlags.DEFAULT)
        while (owner && !owner.get_cursor()) owner = owner.get_parent()
        bump(owner ?? root)
        // One line per cursor setting change. Worth it: this mechanism is invisible by
        // construction — when it does not run there is simply nothing to see.
        console.log(`[CursorRefresh] re-issued on ${root.name || root.constructor?.name}`)
        return true
    } catch (e) {
        console.error("[CursorRefresh]", e)
        return false
    }
}

/**
 * Close the one state nothing else can: nobody holds pointer focus.
 *
 * Picking the cursor THEME goes through a `Gtk.DropDown`, and choosing an item
 * destroys its popover — the surface the pointer was in. Hyprland does not hand the
 * focus to the window underneath, because it only re-runs that pass on pointer motion
 * and the pointer has not moved. Two facts then hold at once, and neither is fixable
 * alone:
 *
 *   - Nobody holds pointer focus, so there is no surface on which to name a shape.
 *     Verified on the wire across three selections with no human input: no `enter`
 *     ever arrives while the mouse is still. ⛔ A settling timer finds nothing however
 *     long it waits — that was tried and measured.
 *   - When the pointer does come back, GTK names `default`, which is the name Hyprland
 *     already has, and its dedupe throws a repeat away. So the focus returning does not
 *     repaint either.
 *
 * So ask the compositor to re-decide what is under the pointer (`reevaluatePointerFocus`
 * — a warp to where the pointer already is; it does not move and no input is
 * synthesised), and re-issue once it has. Measured end to end: `leave(dead popover)` →
 * `enter(parent window)` → our `set_shape(crosshair)` → `set_shape(default)`.
 *
 * ⚠️ Pointer focus cannot be requested by a client. There is no Wayland protocol for
 * it — the compositor assigns it by pointer position alone, which is why this has to
 * go through the compositor at all. `common/FocusGrab.ts` grabs the KEYBOARD, a
 * different seat capability, and is no help here.
 */
const SETTLE_MS = 120

async function refreshAfterRefocus() {
    await hs.reevaluatePointerFocus()
    // The `enter` is on the wire by now; give the main loop one turn to read it before
    // asking GDK where the pointer is.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
        refreshShellCursor()
        return GLib.SOURCE_REMOVE
    })
}

/**
 * Bind it to the moment the compositor has the new theme.
 *
 * `cursor-applied` fires only once `hyprctl setcursor` has resolved: a refresh issued
 * before that faithfully re-issues the OLD picture. `Gtk.Settings` is bound too, for a
 * `gsettings set` from a terminal that ThemeManager never sees.
 */
export function bindCursorThemeRefresh(theme: any): () => void {
    const refresh = () => { if (!refreshShellCursor()) void refreshAfterRefocus() }
    const id = theme.connect("cursor-applied", refresh)

    const settings = Gtk.Settings.get_default()
    const ids = settings
        ? ["notify::gtk-cursor-theme-size", "notify::gtk-cursor-theme-name"]
              .map((sig) => settings.connect(sig, refresh))
        : []

    return () => {
        safeDisconnect(theme, id)
        if (settings) ids.forEach((i) => safeDisconnect(settings, i))
    }
}
