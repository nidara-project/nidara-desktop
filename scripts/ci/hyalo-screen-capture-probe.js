// hyalo-screen-capture-probe.js — for scripts/ci/hyalo-screen-capture-check.sh.
//   gjs -m hyalo-screen-capture-probe.js window          a 320x200 window titled capture-probe: top half red,
//                                                 bottom half blue, and a strip that changes every 50 ms
//                                                 (so a recording has frames to take)
//   gjs -m hyalo-screen-capture-probe.js pixel FILE X Y  prints the pixel's "R G B" of a PNG
//   gjs -m hyalo-screen-capture-probe.js unred FILE X Y W H  how many pixels of that box are not
//                                                 the probe's red (the pointer drawn over it)
//
// The PNG is read by GTK's own loader (Gdk.Texture), never GdkPixbuf: GdkPixbuf hands PNGs to
// glycin, whose sandbox does not start in CI's container (hyalo-capture-probe.js found it).
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"

function download(file) {
    const d = Gdk.TextureDownloader.new(Gdk.Texture.new_from_filename(file))
    d.set_format(Gdk.MemoryFormat.R8G8B8A8)
    const [bytes, stride] = d.download_bytes()
    return { px: bytes.toArray(), stride }
}

if (ARGV[0] === "pixel") {
    const { px, stride } = download(ARGV[1])
    const x = Number(ARGV[2]), y = Number(ARGV[3])
    const o = y * stride + x * 4
    print(`${px[o]} ${px[o + 1]} ${px[o + 2]}`)
} else if (ARGV[0] === "unred") {
    const { px, stride } = download(ARGV[1])
    const [x0, y0, w, h] = ARGV.slice(2, 6).map(Number)
    let n = 0
    for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) {
            const o = y * stride + x * 4
            // Video compression blurs the edge of red a little: only a clear departure counts.
            if (!(px[o] > 150 && px[o + 1] < 100 && px[o + 2] < 100)) n++
        }
    print(n)
} else {
    const app = new Gtk.Application({ application_id: "org.nidara.screencaptureprobe" })
    app.connect("activate", () => {
        const win = new Gtk.Window({ application: app, title: "screen-capture-probe", decorated: false,
            default_width: 320, default_height: 200 })
        const da = new Gtk.DrawingArea({ hexpand: true, vexpand: true })
        let tick = 0
        da.set_draw_func((_a, cr, w, h) => {
            cr.setSourceRGB(1, 0, 0); cr.rectangle(0, 0, w, h / 2); cr.fill()
            cr.setSourceRGB(0, 0, 1); cr.rectangle(0, h / 2, w, h / 2); cr.fill()
            cr.setSourceRGB(1, 1, 1); cr.rectangle((tick * 7) % w, h / 2 - 4, 6, 8); cr.fill()
        })
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { tick++; da.queue_draw(); return GLib.SOURCE_CONTINUE })
        win.set_child(da)
        win.present()
    })
    app.run([])
}
