#!/usr/bin/env gjs -m
/*
 * icon-theme-probe — what the icon theme SAYS vs what it PAINTS, in one process.
 *
 *   # in a live session (VM or host), with the session env exported:
 *   gjs -m scripts/dev/icon-theme-probe.js
 *   # watch a change land, the way the shell makes it happen:
 *   SET=Papirus gjs -m scripts/dev/icon-theme-probe.js
 *
 * Why this exists. On the first session of a CLEAN install the desktop paints
 * Adwaita icons even though `gsettings … icon-theme` says Papirus, and only a
 * shell restart fixes it (measured in the VM, 2026-08-18). Screenshots cannot
 * take that argument any further: three different things could each produce that
 * picture — gsettings not seeded yet, `GtkIconTheme` reporting a name it does not
 * actually paint from, or a consumer that cached a resolved FILE and never
 * looked again. They are indistinguishable from outside the process.
 *
 * So this prints all three at once, and again after a change: the gsettings
 * value, `Gtk.Settings:gtk-icon-theme-name`, `Gtk.IconTheme.get_theme_name()`,
 * and — the part that decides it — the absolute FILE `lookup_icon()` resolves
 * for each specimen. A name that says "Papirus" over a path under
 * `/usr/share/icons/Adwaita` is the whole bug in two lines.
 *
 * Env hooks:
 *   ICONS=a,b,c  specimens to resolve (default: the dock's own line-up, which is
 *                where the defect was seen — Files, terminal, Settings, trash).
 *   SET=<theme>  after the first snapshot, set gsettings to <theme> and keep the
 *                main loop alive for WAIT ms, so the `changed` signal can land.
 *                This is exactly what ThemeManager.applyAll() does at boot.
 *   WAIT=<ms>    how long to wait for it (default 3000).
 *
 * ⚠️ Run it as the SESSION user with the session env (WAYLAND_DISPLAY,
 * DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR). Without a display there is no
 * `Gtk.IconTheme` to ask, and without the session bus gsettings writes land in a
 * different dconf than the shell reads.
 */

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

Gtk.init()

const display = Gdk.Display.get_default()
if (!display) {
    printerr("icon-theme-probe: no display — export the session env first (see the header).")
    imports.system.exit(1)
}

const theme = Gtk.IconTheme.get_for_display(display)
const gtkSettings = Gtk.Settings.get_default()
const interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

const specimens = (GLib.getenv("ICONS") ?? "org.gnome.Nautilus,kitty,nidara-settings,user-trash,gnome-calculator")
    .split(",").map(s => s.trim()).filter(Boolean)

/** The absolute file GTK would actually paint from, or a note saying why there is none. */
function resolvedFile(name) {
    const paintable = theme.lookup_icon(name, null, 48, 1, Gtk.TextDirection.LTR, 0)
    if (!paintable) return "(no paintable)"
    const path = paintable.get_file()?.get_path()
    if (path) return path
    // Symbolic/builtin paintables carry no file; the icon name it fell back to is
    // still worth printing — "image-missing" here means the lookup failed outright.
    return `(no file; icon-name=${paintable.get_icon_name?.() ?? "?"})`
}

function snapshot(label) {
    print(`\n── ${label} ─────────────────────────────────────────`)
    print(`  gsettings icon-theme      : ${interfaceSettings.get_string("icon-theme")}`)
    print(`  Gtk.Settings icon-theme   : ${gtkSettings?.gtk_icon_theme_name}`)
    print(`  IconTheme.get_theme_name(): ${theme.get_theme_name()}`)
    print(`  search path               : ${theme.get_search_path()?.join(":")}`)
    for (const name of specimens)
        print(`  ${name.padEnd(24)} has=${theme.has_icon(name) ? "yes" : "NO "} → ${resolvedFile(name)}`)
}

let changedCount = 0
theme.connect("changed", () => {
    changedCount++
    print(`\n  ‹GtkIconTheme::changed #${changedCount} → theme_name=${theme.get_theme_name()}›`)
})

snapshot("BEFORE")

const target = GLib.getenv("SET")
if (!target) {
    print("\n(no SET= given; set one to watch a change land)")
} else {
    const wait = parseInt(GLib.getenv("WAIT") ?? "3000", 10)
    print(`\n>> setting gsettings icon-theme = ${target}, waiting ${wait} ms…`)
    interfaceSettings.set_string("icon-theme", target)
    const loop = GLib.MainLoop.new(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => { loop.quit(); return GLib.SOURCE_REMOVE })
    loop.run()
    snapshot(`AFTER (changed fired ${changedCount}×)`)
}
