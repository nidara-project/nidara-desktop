import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"

// ── App-icon image helpers ────────────────────────────────────────────────────
// Resolve an icon reference — a theme name OR an absolute file path (AppData.icon
// can be an override PATH once one is set) — into a pixbuf-backed Gtk.Image.
// Shared by the AppIcons page (list rows + detail preview) and the Autostart
// entry rows / app picker.

export function loadPixbuf(iconName: string | null, size: number): GdkPixbuf.Pixbuf | null {
    if (!iconName) return null
    try {
        if (iconName.startsWith("/")) {
            return GdkPixbuf.Pixbuf.new_from_file_at_size(iconName, size, size)
        }
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        const paintable = theme.lookup_icon(iconName, null, size, 1, Gtk.TextDirection.LTR,
            Gtk.IconLookupFlags.FORCE_REGULAR)
        const path = paintable?.get_file()?.get_path()
        if (path) return GdkPixbuf.Pixbuf.new_from_file_at_size(path, size, size)
    } catch {}
    return null
}

export function makeIconImage(iconName: string | null, size: number): Gtk.Image {
    const img = new Gtk.Image({ pixel_size: size })
    const pb = loadPixbuf(iconName, size)
    if (pb) img.set_from_pixbuf(pb)
    else img.icon_name = iconName ?? "application-x-executable"
    return img
}
