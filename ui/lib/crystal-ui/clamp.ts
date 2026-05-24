import { Gtk } from "ags/gtk4"
import Adw from "gi://Adw"

/**
 * CrystalClamp — max-width content container with centering
 *
 * Wraps the child in an Adw.Clamp, which is a pure layout widget (no visual
 * styling of its own). It clamps the child to `maxWidth` pixels and centers
 * it when the available space is larger. Below `maxWidth` the child fills the
 * full available width normally.
 *
 * We use Adw.Clamp here because GTK4's CSS has no max-width property and a
 * correct clamp implementation requires a custom layout manager. Adw.Clamp is
 * a lightweight layout-only widget — it adds no backgrounds, borders or
 * Adwaita-specific chrome.
 *
 * Note: the ancestor CrystalSplitView uses a ZeroMinOverlay to break the
 * minimum-width chain, so the Clamp's content minimum does NOT propagate to
 * the window and does NOT prevent resize/tiling.
 */
export function CrystalClamp(
    child: Gtk.Widget,
    maxWidth = 800,
    vexpand  = true,
): Gtk.Widget {
    const clamp = new Adw.Clamp({
        maximum_size: maxWidth,
        tightening_threshold: maxWidth - 100,
        hexpand: true,
        vexpand,
    })
    clamp.set_child(child)
    if (vexpand) child.vexpand = true
    return clamp
}
