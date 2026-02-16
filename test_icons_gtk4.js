
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

const app = new Gtk.Application({ application_id: 'com.example.IconTest' });

app.connect('activate', () => {
    const display = Gdk.Display.get_default();
    const theme = Gtk.IconTheme.get_for_display(display);

    console.log(`Theme Name: ${theme.theme_name}`);
    console.log(`Search Path: ${theme.get_search_path()}`);

    const names = [
        "notifications-symbolic",
        "preferences-system-notifications-symbolic",
        "alarm-symbolic",
        "bell-symbolic",
        "dialog-information-symbolic",
        "adwaita-logo-symbolic" // control
    ];

    names.forEach(name => {
        const has = theme.has_icon(name);
        console.log(`${name}: ${has ? "FOUND" : "MISSING"}`);
    });

    app.quit();
});

app.run([]);
