import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

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
  // Same glyph as Settings → Users (the shipped Lucide user-round.svg), so all
  // three surfaces show the SAME person icon — the old theme icon
  // (avatar-default-symbolic) came from Adwaita/the icon theme and looked
  // different. The greeter/lockscreen always run from /usr/share (their bin
  // wrappers) and install.sh ships the shell assets there in both modes;
  // NIDARA_SHELL_ROOT covers an in-shell consumer running from source. The SVG
  // renders BLACK (stroke=currentColor, non-symbolic), so the nd-icon class
  // inverts it to white — glyph only, same trick as Settings; the theme icon
  // stays as last resort (symbolic → follows CSS color, must NOT be inverted).
  const glyphPath = `${GLib.getenv("NIDARA_SHELL_ROOT") ?? "/usr/share/nidara/ui/shell"}/assets/icons/hicolor/scalable/actions/user-round.svg`
  const fallback = new Gtk.Image({
    pixel_size: Math.round(size * 0.625),  // Settings profile ratio (60/96)
    width_request: size,
    height_request: size,
    css_classes: [...cssClasses, "greeter-avatar-fallback"],
  })
  if (GLib.file_test(glyphPath, GLib.FileTest.EXISTS)) {
    fallback.gicon = Gio.FileIcon.new(Gio.File.new_for_path(glyphPath))
    fallback.add_css_class("nd-icon")
  } else {
    fallback.icon_name = "avatar-default-symbolic"
  }

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
