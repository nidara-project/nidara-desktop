import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk?version=4.0"
import Graphene from "gi://Graphene"

/**
 * SlicedCairoArea — a Cairo painting that only ever changes LENGTH, drawn as three GPU
 * textures instead of being repainted.
 *
 * The dock's glass capsule widens on every frame of the magnification animation. As a
 * `Gtk.DrawingArea` each frame re-ran the shadow and squircle painters over ~1200 px and
 * uploaded the result: after the icons were moved to textures (#583), `perf` on the live
 * shell still put 38 % of the main thread in `gsk_gpu_upload_cairo_op_draw` — Cairo scan
 * conversion of those curves, every frame (2026-09-15).
 *
 * A shape whose ends do not depend on its length and whose middle is the same column all the
 * way along is exactly "start cap + stretched middle + end cap". This widget paints the shape
 * ONCE at a reference length with the caller's own painter, renders it to textures on the
 * widget's GSK renderer (so they live on the GPU), and per frame appends three of them:
 *   - the start cap, 1:1;
 *   - a 1 px slice of the middle, stretched with NEAREST (every column of the middle is the
 *     same, so stretching it is exact, not an approximation);
 *   - the end cap, 1:1.
 * The textures are rebuilt only when `key()` changes (theme, opacity) or the thickness or
 * scale factor does. `queue_draw()` is enough to make it re-check.
 *
 * ⚠️ The painter must honour the contract, or the slices lie:
 *   - along the stretch axis, nothing may vary between the caps — no gradient, no pattern,
 *     no content whose position depends on the length (a VERTICAL gradient on a horizontal
 *     capsule is fine; the same painter on a vertical capsule is not);
 *   - each cap must fit inside `capLength`.
 * When the widget is shorter than two caps plus one pixel it paints with Cairo directly.
 */
export interface SlicedCairoOptions {
    /** Paint the whole shape into a `length × thickness` box (for horizontal: w × h). */
    paint: (cr: any, width: number, height: number) => void
    /** Logical px each cap occupies along the stretch axis. */
    capLength: (thickness: number) => number
    /** Anything the painting depends on besides size (theme, opacity). */
    key: () => string
}

export const SlicedCairoArea = GObject.registerClass({
    GTypeName: "NidaraSlicedCairoArea",
}, class SlicedCairoArea extends Gtk.Widget {
    private _opts: SlicedCairoOptions | null = null
    private _cacheKey = ""
    private _cap = 0
    private _start: Gdk.Texture | null = null
    private _middle: Gdk.Texture | null = null
    private _end: Gdk.Texture | null = null

    configure(opts: SlicedCairoOptions): void {
        this._opts = opts
        this._cacheKey = ""
        this.queue_draw()
    }

    private _rect(x: number, y: number, w: number, h: number): Graphene.Rect {
        const r = new Graphene.Rect()
        r.init(x, y, w, h)
        return r
    }

    private _build(height: number, sf: number): boolean {
        const renderer = this.get_native()?.get_renderer()
        if (!renderer || !this._opts) return false
        const cap = Math.ceil(this._opts.capLength(height))
        const refW = cap * 2 + 4
        const snap = new Gtk.Snapshot()
        snap.scale(sf, sf)
        const cr = snap.append_cairo(this._rect(0, 0, refW, height))
        try {
            this._opts.paint(cr, refW, height)
        } finally {
            cr.$dispose()
        }
        const node = snap.to_node()
        if (!node) return false
        const H = height * sf
        this._start = renderer.render_texture(node, this._rect(0, 0, cap * sf, H))
        this._middle = renderer.render_texture(node, this._rect((cap + 1) * sf, 0, sf, H))
        this._end = renderer.render_texture(node, this._rect((refW - cap) * sf, 0, cap * sf, H))
        this._cap = cap
        return !!(this._start && this._middle && this._end)
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
        if (!this._opts) return
        const w = this.get_width(), h = this.get_height()
        if (w <= 0 || h <= 0) return
        const sf = this.get_scale_factor()
        const key = `${this._opts.key()}|${h}|${sf}`
        if (key !== this._cacheKey) {
            if (!this._build(h, sf)) return
            this._cacheKey = key
        }
        const cap = this._cap
        if (w < cap * 2 + 1) {
            // Too short to slice: paint it, exactly as a DrawingArea would.
            const cr = snapshot.append_cairo(this._rect(0, 0, w, h))
            try { this._opts.paint(cr, w, h) } finally { cr.$dispose() }
            return
        }
        snapshot.append_scaled_texture(this._start!, Gsk.ScalingFilter.NEAREST, this._rect(0, 0, cap, h))
        snapshot.append_scaled_texture(this._middle!, Gsk.ScalingFilter.NEAREST, this._rect(cap, 0, w - cap * 2, h))
        snapshot.append_scaled_texture(this._end!, Gsk.ScalingFilter.NEAREST, this._rect(w - cap, 0, cap, h))
    }
})

export type SlicedCairoArea = InstanceType<typeof SlicedCairoArea>
