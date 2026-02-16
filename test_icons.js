
const Gtk = imports.gi.Gtk;
Gtk.init(null);

const theme = Gtk.IconTheme.get_default();
const names = [
    "notifications-symbolic",
    "preferences-system-notifications-symbolic",
    "alarm-symbolic",
    "bell-symbolic",
    "audio-volume-high-symbolic"
];

names.forEach(name => {
    const has = theme.has_icon(name);
    console.log(`${name}: ${has ? "FOUND" : "MISSING"}`);
    if (has) {
        const info = theme.lookup_icon(name, 24, 0);
        if (info) console.log(`  -> Path: ${info.get_filename()}`);
    }
});
