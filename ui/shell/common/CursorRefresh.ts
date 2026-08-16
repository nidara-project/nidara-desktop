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
 * The case where nobody holds it — right after a dropdown's popover closes — is handled
 * by `armOnNextEnter`; read it, it is the subtlest part of this file. ⛔ Do NOT try to
 * cover it with a settling timer: measured on the wire across three selections with no
 * human input, no `enter` arrives at all while the mouse is still, so there is nothing
 * for a later attempt to find.
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
 *  Returns false when there was nothing to re-issue it on — see `armOnNextEnter`. */
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
 * Wait for the pointer to come back, then re-issue.
 *
 * 🔑 **Neither half works alone, and that is the whole story of this file.** Pick a
 * cursor theme from a `Gtk.DropDown` and the popover is destroyed under a motionless
 * pointer: nobody holds pointer focus (the parent got `leave` when the popover opened,
 * and no `enter` follows — verified on the wire across three selections with no human
 * input), so there is no surface to name a shape on. Moving the mouse restores focus,
 * but GTK then names `default` — the name Hyprland already has, and its dedupe throws
 * a repeat away. So the pointer coming back does not repaint, and our rename cannot
 * happen until it does.
 *
 * Hence: when the refresh finds nothing to bump, arm the windows and do it on the very
 * next pointer event. That is the moment both conditions hold at once — the pointer is
 * back, and we are the one naming the shape. One shot, removed as soon as it fires: no
 * polling, no timers, no second mechanism. It is the same bump, waiting for the only
 * event that makes it possible.
 *
 * 🔑 **It has to be `motion`, not `enter`.** A `Gtk.Popover` hangs off its parent's
 * widget tree, so the pointer never LEFT the window and no `enter` is ever delivered to
 * it — armed on `enter`, this silently never fires. Verified on the wire: with `enter`
 * the one-pixel move produced only GTK's own `set_shape(1)`; with `motion` it produced
 * `set_shape(8)` then `set_shape(1)`, the rename that repaints. `enter` is kept as well
 * for the case where the pointer arrives from outside the window entirely.
 *
 * ⚠️ Pointer focus cannot be requested. There is no Wayland protocol for a client to
 * take it — the compositor assigns it by pointer position alone. `common/FocusGrab.ts`
 * grabs the KEYBOARD, which is a different seat capability and no help here.
 */
const armedWindows = new WeakSet<Gtk.Window>()
let pending = false

function armOnNextEnter(windows: Gtk.Window[]) {
    pending = true
    for (const w of windows) {
        if (!w.get_mapped() || armedWindows.has(w)) continue
        armedWindows.add(w)

        // ⚠️ The controller is created ONCE per window and NEVER removed. Removing it
        // from inside its own handler — the obvious way to make this one-shot — frees
        // the controller while GTK is still emitting on it, and the shell dies with a
        // segfault the first time a cursor setting is changed from a dropdown. The
        // one-shot lives in `pending` instead, which costs nothing: with nothing
        // pending the handler is a boolean test.
        const ctl = new Gtk.EventControllerMotion()
        const fire = () => {
            if (!pending) return
            pending = false
            refreshShellCursor()
        }
        ctl.connect("motion", fire)
        ctl.connect("enter", fire)
        w.add_controller(ctl)
    }
}

/**
 * Bind it to the moment the compositor has the new theme.
 *
 * `cursor-applied` fires only once `hyprctl setcursor` has resolved: a refresh issued
 * before that faithfully re-issues the OLD picture. `Gtk.Settings` is bound too, for a
 * `gsettings set` from a terminal that ThemeManager never sees.
 */
export function bindCursorThemeRefresh(theme: any, getWindows: () => Gtk.Window[]): () => void {
    const refresh = () => {
        if (refreshShellCursor()) pending = false
        else armOnNextEnter(getWindows())
    }
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
