#!/usr/bin/env gjs -m
// blur-damage — a BOTTOM layer surface that repaints a rectangle every frame, so
// every blurred layer above it has to redo its blur pass over that area. This is
// the load source of the layer-blur A/B harness; `blur-arm.sh` drives it, and
// `references/tech-debt.md` §46 is what it measures. Run it by hand only to eyeball
// the fps.
//
// It must be started with the layer-shell preload, which `blur-arm.sh` does:
//   LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so gjs -m scripts/dev/blur-damage.js
//
// Geometry (DX/DY/DW/DH, default 1600x700 at 480,200) is the 2026-08-04 one: below
// the bar strip, above the dock's, clear of the CC's rect. 🔑 WHERE it sits is not a
// detail — §46's cost is the INTERSECTION of this rect with each surface's declared
// region, so a surface whose region misses this rect measures as free. Say where the
// damage was whenever you quote a number.
//
// ⚠️ The paint is a single GSK COLOR NODE, not cairo. A cairo draw_func rasterises
// 1.1 MP on the CPU every frame and throttles the client to ~30-40 fps — and it
// throttles it by a DIFFERENT amount per arm, which silently makes the two arms
// carry different loads. The whole point of the harness is that the load is the
// constant. Check the fps line before trusting a number; anything below the
// monitor's refresh rate means the arm is void, not merely noisy.
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Cairo from "gi://cairo"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

const W = Number(GLib.getenv("DW") ?? 1600), H = Number(GLib.getenv("DH") ?? 700)
const X = Number(GLib.getenv("DX") ?? 480), Y = Number(GLib.getenv("DY") ?? 200)

Gtk.init()

const Flasher = GObject.registerClass(class Flasher extends Gtk.Widget {
    phase = 0
    vfunc_snapshot(snapshot) {
        const w = this.get_width(), h = this.get_height()
        const rect = new Graphene.Rect()
        rect.init(0, 0, w, h)
        const c = new Gdk.RGBA()
        c.red = (Math.sin(this.phase) + 1) / 2
        c.green = (Math.cos(this.phase * 1.7) + 1) / 2
        c.blue = 0.5
        c.alpha = 1
        snapshot.append_color(c, rect)
    }
})

const app = new Gtk.Application({ application_id: "org.nidara.Damage" })
app.connect("activate", () => {
    const win = new Gtk.ApplicationWindow({ application: app, default_width: W, default_height: H })
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "nidara-damage")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.BOTTOM)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, Y)
    Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.LEFT, X)
    Gtk4LayerShell.set_exclusive_zone(win, -1)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)

    const area = new Flasher({ hexpand: true, vexpand: true })
    win.set_child(area)
    win.present()

    // Click-through: this window exists to cost GPU, not to be in the way.
    const surface = win.get_native()?.get_surface()
    if (surface?.set_input_region) surface.set_input_region(new Cairo.Region())

    let frames = 0
    win.add_tick_callback(() => { area.phase += 0.05; frames++; area.queue_draw(); return GLib.SOURCE_CONTINUE })
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
        print(`fps=${(frames / 2).toFixed(1)}`); frames = 0; return GLib.SOURCE_CONTINUE
    })
})
app.run([])
