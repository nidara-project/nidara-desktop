import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"

/**
 * DockIcon — a dock app icon drawn as GPU textures, not as a Cairo repaint.
 *
 * The dock's magnification resizes every icon on every frame. As a `Gtk.DrawingArea` that
 * meant, per icon per frame: `Gdk.cairo_set_source_pixbuf` converting the 128 px RGBA pixbuf
 * to premultiplied BGRA, pixman scaling it with Cairo's separable-convolution filter, and GTK
 * uploading the result as a new texture. Measured with `perf` on the live shell during 30 s of
 * dock hover: 21 % of the shell's main thread in `bits_image_fetch_separable_convolution_affine`
 * and 13 % in `r8g8b8a8_to_b8g8r8a8_premultiplied`; the shell sat at ~31 % of a core. Headless
 * bench, ten icons animating at 60 Hz: 23.1 % of a core that way, 1.8 % as textures (2026-09-15).
 *
 * Two textures per icon, both built once:
 *  - AT REST, a copy pre-scaled with GdkPixbuf's HYPER filter to the exact device size, drawn
 *    1:1 — as crisp as the Cairo path was (a texture minified by the GPU alone measured a
 *    visibly softer 52 px icon: PSNR 34 dB against the old rendering, vs 47 dB for this);
 *  - IN MOTION, the full 128 px source with mipmaps and TRILINEAR filtering. Sizes between rest
 *    and max only exist for a few frames each, where that softness does not register, and at
 *    max (128) it is exact.
 * The rest copy is rebuilt when the rest size changes (the icon-size setting, a scale change).
 *
 * SYMBOLIC icons (a `*-symbolic` file: Papirus' `view-app-grid-symbolic` is the launcher on the
 * owner's machine) ship a placeholder fill (#444444) that GTK replaces with the CSS `color` when
 * it draws them as a Gtk.Image. Loaded as a pixbuf nothing replaces it, so the launcher drew
 * dark grey in dark mode (measured live, 2026-09-15). With `symbolic` set, the icon keeps its
 * alpha and takes this widget's CSS `color` — `.cd-icon` in _dock.scss — and re-tints when the
 * colour changes (dark/light), like a Gtk.Image would.
 */
export const DockIcon = GObject.registerClass({
    GTypeName: "NidaraDockIcon",
}, class DockIcon extends Gtk.Widget {
    private _source: GdkPixbuf.Pixbuf | null = null
    private _pixbuf: GdkPixbuf.Pixbuf | null = null
    private _symbolic = false
    private _tint = ""
    private _full: Gdk.Texture | null = null
    private _rest: Gdk.Texture | null = null
    private _restKey = ""
    /** The size the icon has when nothing is magnifying it, in logical px — a getter, because
     *  the icon-size setting changes it live without rebuilding the dock. */
    restSize: () => number = () => 0

    setPixbuf(pixbuf: GdkPixbuf.Pixbuf, symbolic = false): void {
        this._source = pixbuf
        this._symbolic = symbolic
        this._tint = ""
        this._useSource(symbolic ? this._tinted(pixbuf, this.get_color()) : pixbuf)
        if (symbolic) this._tint = this._colorKey()
    }

    private _useSource(pixbuf: GdkPixbuf.Pixbuf): void {
        this._pixbuf = pixbuf
        this._full = Gdk.Texture.new_for_pixbuf(pixbuf)
        this._rest = null
        this._restKey = ""
        this.queue_draw()
    }

    private _colorKey(): string {
        const c = this.get_color()
        return `${c.red},${c.green},${c.blue},${c.alpha}`
    }

    /** The icon's alpha, filled with `color` — what GTK does to a symbolic icon. */
    private _tinted(src: GdkPixbuf.Pixbuf, color: Gdk.RGBA): GdkPixbuf.Pixbuf {
        const pb = src.get_has_alpha() ? src : src.add_alpha(false, 0, 0, 0)
        const w = pb.get_width(), h = pb.get_height(), stride = pb.get_rowstride(), n = pb.get_n_channels()
        const px = pb.read_pixel_bytes().toArray() as Uint8Array
        const out = new Uint8Array(px.length)
        const r = Math.round(color.red * 255), g = Math.round(color.green * 255), b = Math.round(color.blue * 255)
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * stride + x * n
                out[i] = r; out[i + 1] = g; out[i + 2] = b
                out[i + 3] = Math.round(px[i + 3] * color.alpha)
            }
        }
        return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(out), GdkPixbuf.Colorspace.RGB, true, 8, w, h, stride)
    }

    vfunc_css_changed(change: any): void {
        super.vfunc_css_changed(change)
        if (!this._symbolic || !this._source) return
        const key = this._colorKey()
        if (key === this._tint) return
        this._tint = key
        this._useSource(this._tinted(this._source, this.get_color()))
    }

    /** The icon's box inside a w×h square, aspect preserved and centred — the old "contain". */
    private _fit(w: number, h: number): Graphene.Rect {
        const pw = this._pixbuf!.get_width(), ph = this._pixbuf!.get_height()
        const scale = Math.min(w / pw, h / ph)
        const dw = pw * scale, dh = ph * scale
        const r = new Graphene.Rect()
        r.init((w - dw) / 2, (h - dh) / 2, dw, dh)
        return r
    }

    private _restTexture(w: number, h: number, factor: number): Gdk.Texture | null {
        const key = `${w}x${h}@${factor}`
        if (this._rest && this._restKey === key) return this._rest
        const fit = this._fit(w, h)
        const dw = Math.max(1, Math.round(fit.get_width() * factor))
        const dh = Math.max(1, Math.round(fit.get_height() * factor))
        const scaled = this._pixbuf!.scale_simple(dw, dh, GdkPixbuf.InterpType.HYPER)
        if (!scaled) return null
        this._rest = Gdk.Texture.new_for_pixbuf(scaled)
        this._restKey = key
        return this._rest
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
        if (!this._pixbuf || !this._full) return
        const w = this.get_width(), h = this.get_height()
        if (w <= 0 || h <= 0) return
        const fit = this._fit(w, h)
        const rest = this.restSize()
        if (rest > 0 && w === rest && h === rest) {
            const tex = this._restTexture(w, h, this.get_scale_factor())
            if (tex) {
                snapshot.append_scaled_texture(tex, Gsk.ScalingFilter.LINEAR, fit)
                return
            }
        }
        snapshot.append_scaled_texture(this._full, Gsk.ScalingFilter.TRILINEAR, fit)
    }
})

export type DockIcon = InstanceType<typeof DockIcon>
