import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import Graphene from "gi://Graphene"
import {
    uncomposite, backdropStats, type BackdropStats, type Rgb,
} from "../../lib/nidara-kit/platform/glass-legibility"
import { LAYER_IGNORE_ALPHA } from "../../lib/nidara-kit/platform/theme-tokens"

/**
 * What a piece of OUR UI really has behind it — the backdrop its text is read
 * against — measured, not guessed (#673).
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 *
 * 1. Capture the rectangle of the screen the widget covers
 *    (`nidara_wl_capture_region`, zwlr_screencopy). That is the compositor's FINAL
 *    frame: our layer composited over the backdrop Hyprland blurred.
 * 2. Render the same widget offscreen, with the window's own renderer, at the
 *    surface's scale — i.e. exactly what we handed the compositor.
 * 3. Per pixel, `screen = ours + backdrop·(1 − ours.a)`, solved for `backdrop`
 *    (`uncomposite`). Where our paint is glass, that is the blurred backdrop as the
 *    text sees it: wallpaper, a fullscreen video, another client's layer — anything.
 *
 * No masks and no guessing which pixels are text: only the BODY of the glass is
 * used — pixels where our paint is flat all around (`isFlatGlass`) — because an
 * edge does not subtract exactly (see there). Validated 2026-09-29: the forward model reproduces the
 * bar's glass in a real screenshot to 1–2/255.
 *
 * ── WHY NOT THE OTHER WAYS (checked in Hyprland 0.56.2) ─────────────────────
 *
 * - A capture WITHOUT our layer does not exist: output/region capture copies the
 *   monitor's final frame, and the `no_screen_share` layer rule paints a BLACK BOX
 *   over the layer rather than leaving it out.
 * - Rebuilding the backdrop from window captures + the wallpaper misses other
 *   clients' layers, and would have to reimplement Hyprland's blur, contrast and
 *   vibrancy. This reads them.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * One region read-back (~7 ms, mostly waiting for the next frame) and one offscreen
 * render of the widget, then a pixel loop over at most `MAX_SAMPLES` pixels. Callers
 * sample on EVENTS (a panel settling open, a window opening under it…), never on a
 * timer: that would be the continuous GPU work the animation rule bans.
 *
 * `NIDARA_BACKDROP_PROBE=0` turns it off; every probe then resolves null and the
 * glass stays exactly as the user's slider sets it.
 */

type Shim = {
    init(): boolean
    capture_region?: (
        connector: string, x: number, y: number, width: number, height: number,
        cancellable: object | null,
        callback: (source: unknown, result: unknown) => void,
    ) => void
    capture_region_finish?: (result: unknown) => Gdk.Texture | null
}

const SHIM_MODULE = "gi://NidaraWl"
const DISABLED = GLib.getenv("NIDARA_BACKDROP_PROBE") === "0"
/** Dev aid: a directory to write each probe's three images into — the capture, our
 *  offscreen render, and the backdrop recovered from them — as `<tag>-*.png`. The
 *  one way to SEE whether the two line up: a misregistration shows as text edges
 *  in the recovered backdrop. */
const DEBUG_DIR = GLib.getenv("NIDARA_BACKDROP_DEBUG")
/** Dev aid: log what each probe cost, and nothing else — no images, so the numbers are
 *  the probe's own (the debug images are written on the main thread and would count). */
const TIMING = GLib.getenv("NIDARA_BACKDROP_TIMING") === "1" || !!DEBUG_DIR

/** Pixels actually inspected per probe, at most. The backdrop behind a panel is
 *  blurred, so a sparse grid over it loses nothing a percentile could see. */
const MAX_SAMPLES = 6000

/** Our paint between these alphas is treated as see-through glass. Below: the
 *  compositor did not blur the backdrop there (`ignore_alpha`), so it is not what
 *  text on glass sits on. Above: text and icons, too opaque to invert precisely. */
// ⚠️ Just above the threshold, NOT with a comfortable margin: the thinnest glass the
// slider allows (`GLASS_RANGE.min`, 0.24 — 61/255) is only one step above it, and a
// margin of 0.02 (the first version) discarded EVERY pixel of it — the one setting
// that needs adapting most measured nothing at all (2026-09-29). A pixel at or below
// the threshold is not blurred and is excluded; AA edges near it fail `isFlatGlass`.
const MIN_ALPHA = LAYER_IGNORE_ALPHA + 0.004
const MAX_ALPHA = 0.9

let shim: Shim | null = null
let ready: Promise<void> | null = null

function load(): Promise<void> {
    if (ready) return ready
    if (DISABLED) {
        console.log("[BackdropProbe] disabled by NIDARA_BACKDROP_PROBE=0 — the glass stays as set")
        ready = Promise.resolve()
        return ready
    }
    // Variable specifier on purpose — see VisibleRegion.ts: a literal makes tsc
    // resolve the module at compile time.
    ready = import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init()) throw new Error("init returned false")
            // An installed shim older than this feature has no capture_region. That
            // is a checkout ahead of its /usr/lib, not an error: say so once.
            if (typeof wl.capture_region !== "function") {
                console.log("[BackdropProbe] libnidara-wl has no capture_region (reinstall it) — the glass stays as set")
                return
            }
            shim = wl
        })
        .catch(e => console.log(`[BackdropProbe] libnidara-wl unavailable — the glass stays as set: ${e}`))
    return ready
}

/** True once the shim is loaded and can capture a region. */
export function isBackdropProbeAvailable(): boolean {
    return shim !== null
}

/** A rectangle in the monitor's logical coordinates. */
export interface MonitorRect { x: number; y: number; width: number; height: number }

function captureRegion(connector: string, r: MonitorRect): Promise<Gdk.Texture | null> {
    return new Promise(resolve => {
        try {
            shim!.capture_region!(connector, r.x, r.y, r.width, r.height, null, (_s, res) => {
                try { resolve(shim!.capture_region_finish!(res)) }
                catch (e) { console.warn(`[BackdropProbe] capture failed: ${e}`); resolve(null) }
            })
        } catch (e) {
            console.warn(`[BackdropProbe] capture_region threw: ${e}`)
            resolve(null)
        }
    })
}

/** How far round a pixel our paint must be uniform for it to count as glass body. */
const FLAT_RADIUS = 2
/** …and how uniform: alpha and every channel within this many 8-bit steps. */
const FLAT_TOLERANCE = 2

/**
 * True when our paint around (x, y) is the same everywhere — the BODY of a piece of
 * glass, away from any text, icon or rim.
 *
 * 🔑 Measured, not assumed (2026-09-29, the bar over the default wallpaper): the
 * offscreen render and the compositor's frame do not antialias a glyph's edge to the
 * same byte, and `uncomposite` divides by (1 − alpha), so an edge pixel a few steps
 * off came back as WHITE backdrop — every letter of the clock outlined in white in the
 * recovered image, and a P95 of (255,220,217) behind a bar sitting on purple. The
 * body of the glass is flat by construction, and the blurred backdrop under it is
 * smooth, so throwing away everything near an edge costs nothing.
 */
function isFlatGlass(px: { data: Uint8Array; stride: number }, x: number, y: number, W: number, H: number): boolean {
    const c = y * px.stride + x * 4
    const d = px.data
    for (let dy = -FLAT_RADIUS; dy <= FLAT_RADIUS; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) return false
        for (let dx = -FLAT_RADIUS; dx <= FLAT_RADIUS; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) return false
            const n = yy * px.stride + xx * 4
            if (Math.abs(d[n] - d[c]) > FLAT_TOLERANCE || Math.abs(d[n + 1] - d[c + 1]) > FLAT_TOLERANCE
                || Math.abs(d[n + 2] - d[c + 2]) > FLAT_TOLERANCE || Math.abs(d[n + 3] - d[c + 3]) > FLAT_TOLERANCE)
                return false
        }
    }
    return true
}

/** RGBA, premultiplied, 8 bits per channel, top row first. */
function pixelsOf(texture: Gdk.Texture): { data: Uint8Array; stride: number; width: number; height: number } {
    // Boxed, not a GObject: `new Gdk.TextureDownloader({...})` throws in GJS.
    const dl = (Gdk.TextureDownloader as any).new(texture)
    dl.set_format(Gdk.MemoryFormat.R8G8B8A8_PREMULTIPLIED)
    const [bytes, stride] = dl.download_bytes()
    return { data: bytes.toArray() as Uint8Array, stride, width: texture.get_width(), height: texture.get_height() }
}

/**
 * Render `widget` as the compositor received it, into a texture the size of a
 * capture of `region` at `scale`. `at` is where the widget's box starts, in the same
 * monitor coordinates as `region`.
 */
function renderOurs(
    widget: Gtk.Widget, at: { x: number; y: number }, box: { width: number; height: number },
    region: MonitorRect, scale: number, pixelW: number, pixelH: number,
): Gdk.Texture | string {
    const native = widget.get_native()
    const renderer = native?.get_renderer()
    if (!renderer) return "the window has no renderer"
    const paintable = Gtk.WidgetPaintable.new(widget)
    const snap = Gtk.Snapshot.new()
    snap.scale(scale, scale)
    snap.translate(new Graphene.Point({ x: at.x - region.x, y: at.y - region.y }))
    paintable.snapshot(snap, box.width, box.height)
    const node = snap.to_node()
    // Null when the widget has not produced a frame yet (just mapped): nothing to
    // subtract, and the caller tries again later.
    if (!node) return "the widget has not painted yet"
    const viewport = new Graphene.Rect()
    viewport.init(0, 0, pixelW, pixelH)
    return renderer.render_texture(node, viewport)
}

function debugSave(tag: string, captured: Gdk.Texture, ours: Gdk.Texture, backdrop: Uint8Array, W: number, H: number) {
    if (!DEBUG_DIR) return
    try {
        GLib.mkdir_with_parents(DEBUG_DIR, 0o755)
        captured.save_to_png(`${DEBUG_DIR}/${tag}-screen.png`)
        ours.save_to_png(`${DEBUG_DIR}/${tag}-ours.png`)
        const tex = Gdk.MemoryTexture.new(W, H, Gdk.MemoryFormat.R8G8B8A8, new GLib.Bytes(backdrop), W * 4)
        tex.save_to_png(`${DEBUG_DIR}/${tag}-backdrop.png`)
    } catch (e) { console.warn(`[BackdropProbe] debug save failed: ${e}`) }
}

export interface ProbeRequest {
    /** The widget whose glass is in question. Rendered with its whole subtree. */
    widget: Gtk.Widget
    /** Where the widget's window starts on its monitor, in logical pixels. The bar
     *  and the other full-monitor layers start at 0,0; a layer anchored with a margin
     *  does not, and GTK cannot tell us where it is. */
    windowOrigin?: { x: number; y: number }
    /** Parts of the region some OTHER surface covers (the Activity Island over the
     *  bar), in monitor coordinates: pixels there are not our paint over a backdrop,
     *  and would read as backdrop if they were subtracted. */
    exclude?: MonitorRect[]
    /** Names the images `NIDARA_BACKDROP_DEBUG` writes. */
    tag?: string
}

/**
 * The backdrop behind `req.widget`, reduced to the statistics the glass rule needs,
 * or null when it cannot be measured (no shim, widget not on screen, too little glass
 * in view). Never rejects: an unmeasured surface keeps the user's glass, which is
 * what it did before any of this existed.
 */
export async function probeBackdrop(req: ProbeRequest): Promise<BackdropStats | null> {
    await load()
    if (!shim) return null
    const { widget } = req
    const why = (reason: string) => { if (DEBUG_DIR) console.log(`[BackdropProbe] ${req.tag ?? "probe"}: ${reason}`); return null }
    const native = widget.get_native()
    const surface = native?.get_surface()
    if (!native || !surface || !widget.get_mapped()) return why("not on screen")

    const display = Gdk.Display.get_default()
    const monitor = display?.get_monitor_at_surface(surface)
    const connector = monitor?.get_connector()
    if (!monitor || !connector) return why("no monitor/connector")

    const [ok, bounds] = widget.compute_bounds(native as unknown as Gtk.Widget)
    if (!ok || bounds.get_width() < 4 || bounds.get_height() < 4)
        return why(ok ? `bounds ${bounds.get_width()}x${bounds.get_height()}` : "no bounds (not in its window?)")
    const origin = req.windowOrigin ?? { x: 0, y: 0 }
    const at = { x: bounds.get_x() + origin.x, y: bounds.get_y() + origin.y }
    const box = { width: bounds.get_width(), height: bounds.get_height() }

    // The capture is in whole logical pixels; the widget's box need not be.
    const region: MonitorRect = {
        x: Math.floor(at.x), y: Math.floor(at.y),
        width: Math.ceil(at.x + box.width) - Math.floor(at.x),
        height: Math.ceil(at.y + box.height) - Math.floor(at.y),
    }

    const t0 = GLib.get_monotonic_time()
    const captured = await captureRegion(connector, region)
    const tCaptured = GLib.get_monotonic_time()
    if (!captured || !widget.get_mapped()) return why(`no capture of ${JSON.stringify(region)} on ${connector}`)
    const W = captured.get_width(), H = captured.get_height()
    // Rendered AFTER the capture lands, so the two describe the same moment as
    // closely as a frame allows. `get_scale()` is the fractional one; the capture is
    // at buffer resolution, so the two agree on the pixel grid.
    const scale = (surface as any).get_scale?.() ?? surface.get_scale_factor()
    const ours = renderOurs(widget, at, box, region, scale, W, H)
    if (typeof ours === "string") return why(`offscreen render: ${ours}`)

    const screenPx = pixelsOf(captured)
    const oursPx = pixelsOf(ours)
    const tRendered = GLib.get_monotonic_time()
    const exclude = (req.exclude ?? []).map(e => ({
        x0: (e.x - region.x) * scale, y0: (e.y - region.y) * scale,
        x1: (e.x + e.width - region.x) * scale, y1: (e.y + e.height - region.y) * scale,
    }))

    const step = Math.max(1, Math.floor(Math.sqrt((W * H) / MAX_SAMPLES)))
    const out: Rgb[] = []
    const dbg = DEBUG_DIR ? new Uint8Array(W * H * 4) : null
    for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
            if (exclude.some(e => x >= e.x0 && x < e.x1 && y >= e.y0 && y < e.y1)) continue
            const o = y * oursPx.stride + x * 4
            const oa = oursPx.data[o + 3] / 255
            if (oa < MIN_ALPHA || oa > MAX_ALPHA) continue
            if (!isFlatGlass(oursPx, x, y, W, H)) continue
            const s = y * screenPx.stride + x * 4
            const b = uncomposite(
                { r: screenPx.data[s] / 255, g: screenPx.data[s + 1] / 255, b: screenPx.data[s + 2] / 255 },
                { r: oursPx.data[o] / 255, g: oursPx.data[o + 1] / 255, b: oursPx.data[o + 2] / 255, a: oa },
                MIN_ALPHA, MAX_ALPHA,
            )
            if (b) {
                out.push(b)
                if (dbg) {
                    const d = (y * W + x) * 4
                    dbg[d] = b.r * 255; dbg[d + 1] = b.g * 255; dbg[d + 2] = b.b * 255; dbg[d + 3] = 255
                }
            }
        }
    }
    const tLooped = GLib.get_monotonic_time()
    if (dbg) debugSave(req.tag ?? "probe", captured, ours, dbg, W, H)
    const stats = backdropStats(out, 64, step * step)
    if (TIMING) console.log(`[BackdropProbe] ${req.tag ?? "probe"}: ${W}x${H}, capture ${((tCaptured - t0) / 1000).toFixed(1)} ms (worker), `
        + `main thread ${((tLooped - tCaptured) / 1000).toFixed(1)} ms = render+readback ${((tRendered - tCaptured) / 1000).toFixed(1)} + ${out.length} samples ${((tLooped - tRendered) / 1000).toFixed(1)}`)
    if (!stats) return why(`${out.length} glass pixels in ${W}x${H} — too few`)
    return stats
}
