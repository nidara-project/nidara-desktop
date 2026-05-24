import { Gtk } from "ags/gtk4"

/**
 * CrystalClamp — centering content container
 *
 * Centers the child in the available width. Unlike Adw.Clamp, this does NOT
 * enforce a maximum width (GTK4 has no CSS max-width; proper clamping needs
 * a GObject subclass). Content fills the available width naturally.
 *
 * The `maxWidth` parameter is kept for API compatibility but is currently
 * unused — true max-width clamping will be revisited when a pure GTK4
 * approach is available.
 *
 * Key property: does NOT set width_request, so it never imposes a minimum
 * window width on its ancestors.
 */
export function CrystalClamp(
    child: Gtk.Widget,
    maxWidth = 800,   // reserved for future use
    vexpand  = true,
): Gtk.Box {
    const box = new Gtk.Box({
        hexpand: true,
        vexpand,
        css_classes: ["crystal-clamp"],
    })
    box.append(child)
    child.hexpand = true
    if (vexpand) child.vexpand = true
    return box
}
