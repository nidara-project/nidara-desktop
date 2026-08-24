#!/usr/bin/env gjs -m
/*
 * icon-text-race — the (so far UNSUCCESSFUL) attempt to reproduce tech-debt #90:
 * the shell segfaulting on app-grid open because GTK's icon-load thread rasterises
 * an SVG containing <text> through Pango while the main thread is also in Pango.
 *
 *   gtk4-broadwayd :7 &
 *   GDK_BACKEND=broadway BROADWAY_DISPLAY=:7 \
 *     ICON=/usr/share/icons/hicolor/scalable/apps/rofi.svg \
 *     ROUNDS=600 TILES=90 gjs -m scripts/dev/icon-text-race.js
 *
 * Exit 0 = survived.  Killed by SIGSEGV = reproduced.
 *
 * ⚠️ THIS PROBE IS KNOWN-BLIND AND ITS GREEN RUNS PROVE NOTHING. It survived 600
 * rounds against the real rofi icon, against a synthetic SVG with 200 <text>
 * elements, and against a no-text control — all three identical, which is the first
 * smell. Then the instrument was checked: 40 `eu-stack -p` samples of the running
 * probe never caught a worker thread inside gsk or pango at all, so GTK was
 * apparently never asked to rasterise an icon off the main thread here. A test that
 * cannot fail is not a passing test.
 *
 * So the FIRST job for whoever picks this up is the instrument, not the experiment:
 * prove the icon load really lands on a GTask thread (a GTK_DEBUG channel,
 * `perf record -g`, or an LD_PRELOAD shim on `pango_renderer_activate` that logs
 * `gettid()`), and only then trust a red or a green from the loop below. The
 * mechanism it is trying to hit is in tech-debt #90, taken from a real core dump.
 */
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"

const ICON = GLib.getenv("ICON") || "/usr/share/icons/hicolor/scalable/apps/rofi.svg"
const ROUNDS = parseInt(GLib.getenv("ROUNDS") || "400", 10)
const TILES = parseInt(GLib.getenv("TILES") || "60", 10)

// Defeat GTK's icon cache: each tile loads its OWN copy of the same file, so every
// round is a fresh parse + rasterise instead of a cache hit.
const tmp = GLib.dir_make_tmp("icon-race-XXXXXX")
const svg = GLib.file_get_contents(ICON)[1]
const copies = []
for (let i = 0; i < TILES; i++) {
    const p = `${tmp}/i${i}.svg`
    GLib.file_set_contents(p, svg)
    copies.push(p)
}

Gtk.init()
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
    // (a) fresh icon loads — GTK rasterises each SVG, on ITS OWN THREAD
    for (let i = 0; i < TILES; i++) {
        images[i].gicon = Gio.FileIcon.new(Gio.File.new_for_path(copies[(i + round) % TILES]))
    }
    // (b) main thread in Pango at the same time — new text every round means new
    //     text nodes rather than cached ones
    for (let i = 0; i < TILES; i++) labels[i].label = `app ${i} · round ${round}`
    if (++round >= ROUNDS) { print(`SURVIVED ${round} rounds`); loop.quit(); return GLib.SOURCE_REMOVE }
    return GLib.SOURCE_CONTINUE
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, tick)
const loop = GLib.MainLoop.new(null, false)
loop.run()
