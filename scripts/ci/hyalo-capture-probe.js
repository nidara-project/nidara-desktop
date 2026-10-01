// hyalo-capture-probe.js — window capture through the standard protocols, end to end (#682).
//
// Two modes, both run by scripts/ci/hyalo-smoke.sh inside a Hyalo session:
//
//   gjs -m hyalo-capture-probe.js window '#2471a3'
//       a plain window filled with one colour (no label: its centre is that colour);
//   gjs -m hyalo-capture-probe.js capture ADDRESS_HEX
//       captures the window at ADDRESS through libnidara-wl exactly as the shell's
//       thumbnails do (core/WindowCapture.ts) and prints `RESULT WxH r,g,b` — the size and
//       the colour at the centre — or `RESULT FAILED: …`. The prefix is what the smoke
//       greps for: libraries print to the same streams (in CI's container, glycin printed
//       its whole bwrap command line, and a `tail -1` read that as the result).
//
// The pixels are read from the texture itself (Gdk.TextureDownloader), never through an
// image loader: GdkPixbuf hands PNGs to glycin, whose sandbox does not start in a container.
//
// The smoke parks the window on a HIDDEN workspace first: a thumbnail is mostly of a window
// that is not on screen, and that is the case a capture that read the screen would miss.

import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"

const [mode, arg] = ARGV

if (mode === "window") {
    const app = new Gtk.Application({ application_id: "org.nidara.captureprobe" })
    app.connect("activate", () => {
        const w = new Gtk.ApplicationWindow({ application: app, title: "capture probe", default_width: 480, default_height: 320 })
        const css = new Gtk.CssProvider()
        css.load_from_string(`window { background: ${arg}; }`)
        Gtk.StyleContext.add_provider_for_display(w.get_display(), css, 800)
        w.present()
    })
    app.run([])
} else if (mode === "capture") {
    Gtk.init()
    const NidaraWl = (await import("gi://NidaraWl")).default
    const loop = new GLib.MainLoop(null, false)
    if (!NidaraWl.init() || !NidaraWl.has_capture()) {
        print("RESULT FAILED: libnidara-wl sees no window capture in this compositor")
    } else {
        NidaraWl.capture_window(Number(BigInt(`0x${arg}`)), 480, 320, null, (_s, res) => {
            try {
                const t = NidaraWl.capture_window_finish(res)
                const d = Gdk.TextureDownloader.new(t)
                d.set_format(Gdk.MemoryFormat.R8G8B8A8)
                const [bytes, stride] = d.download_bytes()
                const px = bytes.toArray()
                const at = Math.floor(t.get_height() / 2) * stride + Math.floor(t.get_width() / 2) * 4
                print(`RESULT ${t.get_width()}x${t.get_height()} ${px[at]},${px[at + 1]},${px[at + 2]}`)
            } catch (e) {
                print(`RESULT FAILED: ${e}`)
            }
            loop.quit()
        })
        loop.run()
    }
} else {
    print("usage: hyalo-capture-probe.js window '#rrggbb' | capture ADDRESS_HEX")
}
