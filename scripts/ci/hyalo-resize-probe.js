// A GTK4 window with no client resize grips, like NidaraWindow. Its minimum is
// deliberate: the check compares GTK's actual allocation with Hyalo's tile.
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const app = new Gtk.Application({ application_id: 'org.nidara.resizeprobe', flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({ application: app, title: 'resize-probe',
        decorated: false, resizable: ARGV[0] !== 'fixed', default_width: 480, default_height: 320 });
    const css = new Gtk.CssProvider();
    css.load_from_string(`window { background: ${GLib.getenv('HYALO_PROBE_COLOR') ?? '#333333'}; }`);
    Gtk.StyleContext.add_provider_for_display(win.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    win.set_child(new Gtk.Box({ width_request: 400, height_request: 240 }));
    let last = '';
    win.add_tick_callback(() => {
        const size = `${win.get_width()} ${win.get_height()}`;
        if (size !== last) { print(`SIZE ${size}`); last = size; }
        return true;
    });
    win.present();
});
app.run([]);
