import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"

// Circular user avatar shared by the greeter and the lockscreen.
// A plain Gtk.Image can't produce the Settings → Users circle: it fit-scales
// (letterboxes) non-square files, and CSS border-radius doesn't clip an image's
// content. Same recipe as Settings → Users: center-crop the pixbuf to a square,
// scale it to the target size, hand it to a Gtk.Picture (SCALE_DOWN +
// can_shrink:false so layout can't stretch it) and let the pill border-radius
// cut the circle. Falls back to the generic user glyph when there's no photo —
// or when the file can't be read (e.g. a ~/.face the greeter user can't open).

export interface AvatarHandle {
  widget: Gtk.Widget
  setSource(path: string | null): void
}

export function makeAvatar(size: number, cssClasses: string[] = ["greeter-avatar"]): AvatarHandle {
  const picture = new Gtk.Picture({
    width_request: size,
    height_request: size,
    content_fit: Gtk.ContentFit.SCALE_DOWN,
    can_shrink: false,
    css_classes: cssClasses,
  })
  const fallback = new Gtk.Image({
    icon_name: "avatar-default-symbolic",
    pixel_size: Math.round(size * 0.55),
    width_request: size,
    height_request: size,
    css_classes: [...cssClasses, "greeter-avatar-fallback"],
  })

  const box = new Gtk.Box({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
  let current: Gtk.Widget | null = null
  const show = (w: Gtk.Widget) => {
    if (current === w) return
    if (current) box.remove(current)
    box.append(w)
    current = w
  }

  const setSource = (path: string | null) => {
    if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
      try {
        let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
        const w = pixbuf.get_width(), h = pixbuf.get_height()
        const side = Math.min(w, h)
        if (w !== h) pixbuf = pixbuf.new_subpixbuf((w - side) >> 1, (h - side) >> 1, side, side)
        pixbuf = pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.BILINEAR)!
        picture.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
        show(picture)
        return
      } catch (_) { /* unreadable/corrupt file → glyph */ }
    }
    show(fallback)
  }
  show(fallback)

  return { widget: box, setSource }
}
