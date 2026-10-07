// hyalo-x11-probe.js — an X11 client for hyalo-x11-check.sh: a GTK 3 app on Xwayland
// (GDK_BACKEND=x11), driven by keys the check types through HYALO_CONTROL.
//
//   window   a window (WM_CLASS org.nidara.x11probe) that prints READY, then for each key:
//              KEY <name>; on `c` it copies "from-x11" (COPIED); on `v` it prints the clipboard
//              (CLIP <text>) — both need the X input focus, which Hyalo must give it
//   popup    an override-redirect window at 100,100, 120×80: red in its first frame, green from
//              the next; prints SHOWN, then GREEN once it has drawn it. Without frame callbacks
//              Xwayland never commits that second frame (xwayland.rs; Steam's black menus)
//   pixel PNG X Y   prints the pixel's colour as `RGB r g b`
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import System from 'system';

const [mode, ...rest] = ARGV;
const out = s => print(s);

if (mode === 'pixel') {
    const [path, x, y] = rest;
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const px = pb.get_pixels();
    const o = Number(y) * pb.get_rowstride() + Number(x) * pb.get_n_channels();
    out(`RGB ${px[o]} ${px[o + 1]} ${px[o + 2]}`);
    System.exit(0);
}

Gtk.init(null);

if (mode === 'window') {
    const win = new Gtk.Window({ title: 'x11-probe', default_width: 320, default_height: 200 });
    // WM_CLASS, set before the window is realized: what Hyalo reads as its app id.
    win.set_wmclass('x11probe', 'org.nidara.x11probe');
    const clipboard = Gtk.Clipboard.get(Gdk.Atom.intern('CLIPBOARD', false));
    win.connect('key-press-event', (_w, event) => {
        const name = Gdk.keyval_name(event.get_keyval()[1]);
        out(`KEY ${name}`);
        if (name === 'c') {
            clipboard.set_text('from-x11', -1);
            out('COPIED');
        } else if (name === 'v') {
            clipboard.request_text((_c, text) => out(`CLIP ${text}`));
        }
        return true;
    });
    win.connect('destroy', () => Gtk.main_quit());
    win.show_all();
    out('READY');
} else if (mode === 'popup') {
    const win = new Gtk.Window({ type: Gtk.WindowType.POPUP });
    win.move(100, 100);
    win.set_default_size(120, 80);
    let green = false;
    const area = new Gtk.DrawingArea();
    area.connect('draw', (_a, cr) => {
        cr.setSourceRGB(green ? 0 : 1, green ? 1 : 0, 0);
        cr.paint();
        if (green) {
            out('GREEN');
        }
        return true;
    });
    win.add(area);
    win.show_all();
    out('SHOWN');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        green = true;
        area.queue_draw();
        return GLib.SOURCE_REMOVE;
    });
} else {
    printerr(`unknown mode ${mode}`);
    System.exit(2);
}
Gtk.main();
