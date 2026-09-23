// sliced-capsule-probe — ui/lib/sliced-cairo.ts against the DrawingArea it replaced, with the
// dock capsule's own painters.
//   gjs -m probe.js still <width>   old (top) and sliced (bottom) capsule at <width>, for grim
//   gjs -m probe.js anim <old|sliced>  CPU while the capsule's width animates, 600 frames
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import { SlicedCairoArea } from "../../ui/lib/sliced-cairo"
import { cairoDraw } from "../../ui/lib/nidara-kit/platform/cairo-draw"
import { drawGlassShadow, GLASS_SHADOW } from "../../ui/lib/nidara-kit/platform/glass-paint"
import { drawSquircle } from "../../ui/shell/common/DrawingUtils"
import { GLASS_TINT } from "../../ui/lib/nidara-kit/platform/tokens"

const [mode = "still", arg = "640"] = (globalThis as any).ARGV ?? []
const PAD = GLASS_SHADOW.spread, PILL = 72, H = PILL + PAD * 2
const paint = (cr: any, w: number, h: number) => {
    const c = GLASS_TINT.dark
    drawGlassShadow(cr, PAD, PAD, w - PAD * 2, h - PAD * 2, (h - PAD * 2) / 2, 3.2, false, GLASS_SHADOW.spread, GLASS_SHADOW.alpha, GLASS_SHADOW.drop)
    drawSquircle(cr, w, h, undefined, 0.55, true, { r: c.r, g: c.g, b: c.b }, undefined, false, { r: 1, g: 1, b: 1, a: 0.12 }, 3.2, 1.0, PAD)
}
const cpu = () => { const [, b] = GLib.file_get_contents("/proc/self/stat"); const f = new TextDecoder().decode(b).split(") ")[1].split(" "); return (+f[11] + +f[12]) / 100 }

Gtk.init()
const win = new Gtk.Window({ default_width: 1280, default_height: 300 })
const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 20, margin_top: 20, margin_start: 20 })
const old = new Gtk.DrawingArea({ halign: Gtk.Align.START, height_request: H })
old.set_draw_func(cairoDraw((_a: any, cr: any, w: number, h: number) => paint(cr, w, h)))
const sliced = new SlicedCairoArea({ halign: Gtk.Align.START, height_request: H })
sliced.configure({ key: () => "k", capLength: (h) => PAD + (h - PAD * 2) / 2 + 1, paint })
if (mode === "still" || arg === "old") col.append(old)
if (mode === "still" || arg === "sliced") col.append(sliced)
old.set_size_request(+arg || 640, H); sliced.set_size_request(+arg || 640, H)
win.set_child(col)
win.present()
const loop = new GLib.MainLoop(null, false)
if (mode === "anim") {
    const target = arg === "old" ? old : sliced
    let f = 0, c0 = 0, t0 = 0
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        c0 = cpu(); t0 = GLib.get_monotonic_time()
        win.add_tick_callback(() => {
            f++
            target.set_size_request(700 + Math.round(400 * Math.abs(Math.sin(f / 30))), H)
            target.queue_draw()
            if (f < 600) return GLib.SOURCE_CONTINUE
            const dt = (GLib.get_monotonic_time() - t0) / 1e6, dc = cpu() - c0
            print(`capsule ${arg}: ${(100 * dc / dt).toFixed(1)}% of a core, ${(1000 * dc / f).toFixed(2)} ms/frame`)
            loop.quit()
            return GLib.SOURCE_REMOVE
        })
        return GLib.SOURCE_REMOVE
    })
}
loop.run()
