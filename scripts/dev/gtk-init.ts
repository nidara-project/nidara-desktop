// Opens a GTK display for a probe, and nothing else.
//
// It is a separate module because ES import declarations all run before the first
// statement of the importing file: `Gtk.init()` written inline in a probe would
// execute AFTER the service under test had already been constructed. Services that
// touch `Gtk.IconTheme.get_for_display(Gdk.Display.get_default())` at construction
// time (core/AppService) throw on a null display, so the probe imports this FIRST
// and its own imports after.
import { Gtk } from "ags/gtk4"

Gtk.init()
