#!/usr/bin/env gjs -m
/*
 * icon-text-race — REPRODUCES tech-debt #90: the shell dies with SIGSEGV because
 * GTK rasterises an SVG icon containing <text> on its icon-load thread while the
 * main thread is also inside Pango, and Pango's font map and Cairo's scaled-font
 * cache are not thread-safe.
 *
 *   MODE=name  ICON_NAME=rofi    ROUNDS=600 TILES=90 gjs -m scripts/dev/icon-text-race.js
 *   MODE=file  ICON=/path/x.svg  ROUNDS=600 TILES=90 gjs -m scripts/dev/icon-text-race.js
 *
 * Killed by SIGSEGV = reproduced.  Exit 0 = survived; the crash is a race and does
 * not fire every time (measured 5 of 6 runs on 2026-08-31, gtk4 1:4.22.4-1).
 *
 * 🔑 MODE=name IS THE WHOLE PROBE, AND MODE=file IS ITS NEGATIVE CONTROL. This
 * script spent a week unable to fail because it only had the second one. GTK
 * reaches its icon-load thread from exactly one place — `gtk_icon_theme_lookup_icon()`
 * with `GTK_ICON_LOOKUP_PRELOAD`, which hands the load to `load_icon_thread` in
 * gtkicontheme.c. A `Gio.FileIcon` never gets there: `gtk_icon_theme_lookup_by_gicon()`
 * answers a GFileIcon with `gtk_icon_paintable_new_for_file()` and the load stays on
 * the main thread. So the file mode rasterises the same text-carrying SVG hundreds of
 * thousands of times, on ONE thread, and survives everything — which looked like
 * evidence about the bug and was evidence about the probe.
 *
 * ⚠️ Do not trust either result without `scripts/dev/pangotrace.c` loaded. It counts
 * Pango entries per thread, and it is what turns "survived" into a fact:
 *
 *     cc -shared -fPIC -O2 -o /tmp/pangotrace.so scripts/dev/pangotrace.c -ldl
 *     LD_PRELOAD=/tmp/pangotrace.so MODE=file gjs -m scripts/dev/icon-text-race.js
 *       → 1,184,130 draw_layout + 376,814 show_glyph_string, 1 thread, 0 overlaps
 *     LD_PRELOAD=/tmp/pangotrace.so MODE=name gjs -m scripts/dev/icon-text-race.js
 *       → first off-main call, first overlap, then SIGSEGV in a `pool-N` thread
 *
 * The icon name has to resolve to an SVG that actually contains <text>. On this
 * machine that is `rofi` (no Papirus copy, so it falls through to
 * /usr/share/icons/hicolor/scalable/apps/rofi.svg, which carries three). The control
 * for the CAUSE — as opposed to the control for the instrument — is any text-free
 * icon down the same threaded path: `ICON_NAME=firefox` survived 4 of 4.
 */
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

const MODE   = GLib.getenv("MODE") || "name"
const NAME   = GLib.getenv("ICON_NAME") || "rofi"
const ICON   = GLib.getenv("ICON") || "/usr/share/icons/hicolor/scalable/apps/rofi.svg"
const ROUNDS = parseInt(GLib.getenv("ROUNDS") || "600", 10)
const TILES  = parseInt(GLib.getenv("TILES") || "90", 10)

Gtk.init()

// MODE=file only: defeat GTK's icon cache by giving each tile its own copy of the
// same file, so every round is a fresh parse + rasterise instead of a cache hit.
let copies = []
if (MODE === "file") {
    const tmp = GLib.dir_make_tmp("icon-race-XXXXXX")
    const svg = GLib.file_get_contents(ICON)[1]
    for (let i = 0; i < TILES; i++) {
        const p = `${tmp}/i${i}.svg`
        GLib.file_set_contents(p, svg)
        copies.push(p)
    }
}

const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
if (MODE === "name" && !theme.has_icon(NAME))
    printerr(`WARNING: the icon theme does not know "${NAME}" — this run measures nothing`)

const win = new Gtk.Window({ default_width: 900, default_height: 700 })
const grid = new Gtk.FlowBox({ max_children_per_line: 8 })
win.set_child(new Gtk.ScrolledWindow({ child: grid }))

const labels = []
const images = []
for (let i = 0; i < TILES; i++) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
    const img = new Gtk.Image({ pixel_size: 64 })
    const lbl = new Gtk.Label({ label: `app ${i}`, ellipsize: 3, max_width_chars: 12 })
    box.append(img); box.append(lbl)
    grid.append(box)
    images.push(img); labels.push(lbl)
}
win.present()

let round = 0
const tick = () => {
    // (a) fresh icon loads. In `name` mode PRELOAD sends each one to GTK's icon
    //     thread, and the size varies per tile because the paintable cache is keyed
    //     on (name, size, scale) — a constant size would serve round 2 from cache
    //     and quietly stop loading anything at all.
    for (let i = 0; i < TILES; i++) {
        if (MODE === "name") {
            images[i].paintable = theme.lookup_icon(
                NAME, null, 16 + ((i + round) % 112), 1,
                Gtk.TextDirection.LTR, Gtk.IconLookupFlags.PRELOAD)
        } else {
            images[i].gicon = Gio.FileIcon.new(Gio.File.new_for_path(copies[(i + round) % TILES]))
        }
    }
    // (b) main thread in Pango at the same time — new text every round means new
    //     text nodes rather than cached ones
    for (let i = 0; i < TILES; i++) labels[i].label = `app ${i} · round ${round}`
    if (++round >= ROUNDS) { print(`SURVIVED ${round} rounds (MODE=${MODE})`); loop.quit(); return GLib.SOURCE_REMOVE }
    return GLib.SOURCE_CONTINUE
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, tick)
const loop = GLib.MainLoop.new(null, false)
loop.run()
