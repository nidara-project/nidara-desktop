// dock-icon-probe — DockIcon (surfaces/dock/DockIcon.ts) off the live shell: CPU per frame
// while ten icons animate their size, and a still frame at a given size for pixel compare.
//   gjs -m probe.js anim            → prints CPU % of a core over 600 frames
//   gjs -m probe.js still <px> <rest> → holds icons at <px> with rest size <rest>, for grim
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { DockIcon } from "../../ui/shell/surfaces/dock/DockIcon"

const [mode = "anim", pxArg = "52", restArg = "52", iconPath = "/usr/share/icons/hicolor/scalable/apps/firefox.svg"] = (globalThis as any).ARGV ?? []
const cpu = () => { const [, b] = GLib.file_get_contents("/proc/self/stat"); const f = new TextDecoder().decode(b).split(") ")[1].split(" "); return (+f[11] + +f[12]) / 100 }
Gtk.init()
const pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(iconPath, 128, 128, true)
const win = new Gtk.Window({ default_width: 1100, default_height: 200 })
const box = new Gtk.Box({ spacing: 4 })
const icons = Array.from({ length: 10 }, () => {
    const i = new DockIcon({ valign: Gtk.Align.CENTER })
    i.restSize = () => +restArg
    i.setPixbuf(pix!)
    i.set_size_request(+pxArg, +pxArg)
    box.append(i)
    return i
})
win.set_child(box)
win.present()
const loop = new GLib.MainLoop(null, false)
if (mode === "anim") {
    let f = 0, c0 = 0, t0 = 0
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        c0 = cpu(); t0 = GLib.get_monotonic_time()
        win.add_tick_callback(() => {
            f++
            icons.forEach((w, i) => { const s = 48 + Math.round(40 * Math.abs(Math.sin((f + i * 6) / 20))); w.set_size_request(s, s) })
            if (f < 600) return GLib.SOURCE_CONTINUE
            const dt = (GLib.get_monotonic_time() - t0) / 1e6, dc = cpu() - c0
            print(`DockIcon anim frames=${f} cpu=${(100 * dc / dt).toFixed(1)}% of a core, ${(1000 * dc / f).toFixed(2)} ms/frame`)
            loop.quit()
            return GLib.SOURCE_REMOVE
        })
        return GLib.SOURCE_REMOVE
    })
}
loop.run()
