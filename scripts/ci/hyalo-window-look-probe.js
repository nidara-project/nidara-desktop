// hyalo-window-look-probe.js — for scripts/ci/hyalo-window-look-check.sh.
//   gjs -m hyalo-window-look-probe.js stripes             an opaque 600x400 window, title look-stripes:
//                                                        red and green vertical stripes 6 px wide
//   gjs -m hyalo-window-look-probe.js glass               a translucent 300x200 window, title look-glass:
//                                                        dark grey at 30 % over whatever is behind it
//   gjs -m hyalo-window-look-probe.js pixel FILE X Y      the pixel's "R G B"
//   gjs -m hyalo-window-look-probe.js spread FILE X Y W H how far the green channel varies across a
//                                                        row of the box: its standard deviation
//   gjs -m hyalo-window-look-probe.js darkest FILE X Y W H the darkest pixel's mean of R, G and B in
//                                                        the box (hyalo-title-bar-check.sh: the ink)
//
// No decoration (decorated: false), so a window's surface IS its box: Hyalo rounds it.
// PNGs are read by GTK's own loader (Gdk.Texture), never GdkPixbuf (glycin's sandbox does not
// start in CI's container).
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

const pixels = (file) => {
    const texture = Gdk.Texture.new_from_filename(file)
    const d = Gdk.TextureDownloader.new(texture)
    d.set_format(Gdk.MemoryFormat.R8G8B8A8)
    const [bytes, stride] = d.download_bytes()
    return { px: bytes.toArray(), stride }
}

const mode = ARGV[0]
if (mode === "pixel") {
    const { px, stride } = pixels(ARGV[1])
    const o = Number(ARGV[3]) * stride + Number(ARGV[2]) * 4
    print(`${px[o]} ${px[o + 1]} ${px[o + 2]}`)
} else if (mode === "spread") {
    const { px, stride } = pixels(ARGV[1])
    const [x, y, w, h] = ARGV.slice(2, 6).map(Number)
    const row = y + Math.floor(h / 2)
    const values = []
    for (let i = x; i < x + w; i++) values.push(px[row * stride + i * 4 + 1])
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
    print(sd.toFixed(1))
} else if (mode === "darkest") {
    const { px, stride } = pixels(ARGV[1])
    const [x, y, w, h] = ARGV.slice(2, 6).map(Number)
    let least = 255
    for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) {
            const o = j * stride + i * 4
            least = Math.min(least, Math.round((px[o] + px[o + 1] + px[o + 2]) / 3))
        }
    print(least)
} else {
    const glass = mode === "glass"
    const app = new Gtk.Application({ application_id: glass ? "org.nidara.lookglass" : "org.nidara.lookstripes" })
    app.connect("activate", () => {
        const css = new Gtk.CssProvider()
        css.load_from_string(glass ? "window { background: rgba(40, 40, 40, 0.3); }" : "window { background: black; }")
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER)
        const win = new Gtk.Window({
            application: app,
            title: glass ? "look-glass" : "look-stripes",
            decorated: false,
            default_width: glass ? 300 : 600,
            default_height: glass ? 200 : 400,
        })
        if (!glass) {
            const da = new Gtk.DrawingArea({ hexpand: true, vexpand: true })
            da.set_draw_func((_a, cr, w, h) => {
                for (let x = 0; x < w; x += 6) {
                    const red = Math.floor(x / 6) % 2 === 0
                    cr.setSourceRGB(red ? 1 : 0, red ? 0 : 1, 0)
                    cr.rectangle(x, 0, 6, h)
                    cr.fill()
                }
            })
            win.set_child(da)
        }
        win.present()
    })
    app.run([])
}
