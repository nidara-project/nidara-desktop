import { Gdk, Gtk } from "ags/gtk4"
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
 * And it cannot help the one case where NOBODY holds pointer focus: right after a
 * `Gtk.DropDown`'s popover closes with the mouse held still, the popover is unmapped,
 * the compositor sends no `enter` to the parent, and GDK keeps reporting the dead
 * popover indefinitely. Verified on the wire: three bumps at +0/+250/+800 ms, all onto
 * `Gtk_Popover mapped=false`, **zero** `set_shape` sent. The cursor THEME is only
 * reachable through a dropdown, so it still waits for the next mouse movement — one
 * pixel is enough, where before it needed leaving the window. Do not add settling
 * timers for this; they were tried and measured useless.
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

/** Re-issue the cursor on whichever of our surfaces the pointer is in. */
export function refreshShellCursor() {
    try {
        const pointer = Gdk.Display.get_default()?.get_default_seat()?.get_pointer()
        const [surface, sx, sy] = pointer?.get_surface_at_position() ?? []
        if (!surface) return

        const native = Gtk.Native.get_for_surface(surface)
        if (!native) return

        // Surface coordinates are not widget coordinates — a native's widget origin is
        // inset by its shadow, and `pick` wants the latter.
        const [tx, ty] = native.get_surface_transform()
        const root = native as unknown as Gtk.Widget

        // GTK resolves a surface's cursor from the widget under the pointer upwards, so
        // bump whichever widget actually owns it — several Settings rows set their own.
        let owner: Gtk.Widget | null = root.pick(sx - tx, sy - ty, Gtk.PickFlags.DEFAULT)
        while (owner && !owner.get_cursor()) owner = owner.get_parent()
        bump(owner ?? root)
    } catch (e) {
        console.error("[CursorRefresh]", e)
    }
}

/**
 * Bind it to the moment the compositor has the new theme.
 *
 * `cursor-applied` fires only once `hyprctl setcursor` has resolved: a refresh issued
 * before that faithfully re-issues the OLD picture. `Gtk.Settings` is bound too, for a
 * `gsettings set` from a terminal that ThemeManager never sees.
 */
export function bindCursorThemeRefresh(theme: any): () => void {
    const id = theme.connect("cursor-applied", refreshShellCursor)

    const settings = Gtk.Settings.get_default()
    const ids = settings
        ? ["notify::gtk-cursor-theme-size", "notify::gtk-cursor-theme-name"]
              .map((sig) => settings.connect(sig, refreshShellCursor))
        : []

    return () => {
        safeDisconnect(theme, id)
        if (settings) ids.forEach((i) => safeDisconnect(settings, i))
    }
}
