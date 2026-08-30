// One window, one identity.
//
// A GApplication has a single `application-id`, and GTK4 hands that string to
// the Wayland compositor as the app-id of every regular window the process
// opens. The shell is one process that opens windows belonging to different
// things — the Settings window is a real application window, About is its
// sibling — so a process-wide id is the wrong granularity, and for years the
// consequence was the seventh commandment: Hyprland filed Settings under
// `io.Astal.ags` (AGS's id, not even ours), no icon theme had art for that name,
// and `core/AppService` carried a remap so the dock, the app grid and the
// workspace overview could agree on what the window was. Every surface that
// forgot to go through the remap drew the generic glyph.
//
// The compositor takes a per-toplevel override, and that DELETES the remap
// instead of renaming it: the window announces `nidara-settings`, the desktop
// registry already has `nidara-settings.desktop`, and identity resolution
// becomes a lookup with no special cases in it.
//
// ⚠️ TWO things had to be measured, and each one fails SILENTLY when wrong:
//
//  1. **The GdkWayland import below is load-bearing, not decoration.** Without
//     the typelib loaded, GJS sees the surface as `unknown_GdkWaylandToplevel`
//     and it has NO methods — `typeof surface.set_application_id` is
//     `"undefined"`, so a defensive guard turns the whole feature into a no-op
//     that logs nothing. That is exactly how this was written the first time.
//  2. **Timing.** GTK creates the `xdg_toplevel`, and sets the process-wide
//     app-id on it, inside the window's first `present()` — which happens at
//     MAP, not at realize. An override applied on `realize` is silently undone a
//     moment later. Measured at three hooks (`map`, after-`map`,
//     after-`present`): all three land, so this uses the earliest.
//
// 🔴 IT IS NOT EARLY ENOUGH FOR WINDOW RULES. This paragraph used to claim the
// opposite — that `set_app_id` goes out in the same main-loop iteration, with no
// buffer yet, so the compositor has not matched rules — and it is FALSE, measured
// 2026-08-30 with a minimal GTK4 window whose only variable was when the app-id
// arrives. Hyprland matches its rules against the PROCESS app-id GTK put on the
// toplevel at creation; a window whose rule names only the stamped class spends
// its first frames TILED, and GTK, told it is maximized, ADOPTS the tile as its
// size. On an empty workspace that is the whole work area — which is what "the
// installer opens at monitor size" was.
//
//     app-id from birth ................... 960x760 (its own default)
//     app-id stamped here, rule on it .... 2544x1284 (the work area)
//     app-id stamped here, rule on the
//       birth class or an early title .... 960x760
//
// ⚠️ So this function is right, and stamping is right — the dock, the desktop
// registry and `resolveWindowApp` all read the final class and are correct. What
// cannot be trusted is a WINDOW RULE keyed on it alone. Any rule matching one of
// these classes must also name the birth class:
//
//     match = { class = "^(org\\.nidara\\.installer|nidara-installer)$" }
//
// See `.claude/skills/nidara/references/dev-workflow.md` → "A window rule matches
// an IDENTIFIER, never interface text — and our identifiers arrive LATE".

import Gtk from "gi://Gtk?version=4.0"
// Side-effect import: see (1) above. Ships with gtk4 itself.
import "gi://GdkWayland?version=4.0"

/**
 * Declare `appId` as the Wayland app-id of this window alone — what
 * `hyprctl clients` reports as its `class`, what window rules match, and what
 * `AppService.resolveWindowApp` is handed.
 *
 * Call it any time after constructing the window; before `present()` is the
 * normal case. Safe to call twice.
 */
export function setWindowAppId(win: Gtk.Window, appId: string): void {
  const apply = (): void => {
    const surface = win.get_surface() as any
    if (!surface) return
    if (typeof surface.set_application_id !== "function") {
      // Not a Wayland toplevel (or a typelib that no longer exposes it). Say so
      // — a window quietly keeping the process-wide id is the bug this file
      // exists to prevent.
      console.warn(`[app-id] "${appId}" not applied: ${surface.constructor?.name} has no set_application_id`)
      return
    }
    try {
      surface.set_application_id(appId)
    } catch (e) {
      console.warn(`[app-id] could not set "${appId}" on ${win.name ?? "window"}:`, e)
    }
  }

  if (win.get_mapped()) apply()
  else win.connect("map", apply)
}
