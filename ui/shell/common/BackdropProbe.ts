import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import Graphene from "gi://Graphene"
import {
    uncomposite, backdropStats, hyprlandPrepare, hyprlandVibrancy,
    type BackdropStats, type Rgb, type HyprlandBlurParams,
} from "../../lib/nidara-kit/platform/glass-legibility"
import { LAYER_IGNORE_ALPHA } from "../../lib/nidara-kit/platform/theme-tokens"
import compositor from "../core/CompositorState"

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
    // Asked, not attempted: every measurement failing on its own was a warning per event
    // (34 in a Hyalo session's first minutes, 2026-10-01).
    if (!compositor.caps.backdropCapture) {
        console.log(`[BackdropProbe] ${compositor.kind} measures under the glass itself — the glass stays as set`)
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
    /** The part of the widget's box to capture, in the widget's own coordinates, when
     *  that is not the whole box. The widget is still rendered WHOLE over it, so
     *  everything of ours that paints there is subtracted. The dock: its layout spans
     *  the monitor, and what is glass is the capsule — the icons painted over it are
     *  a sibling of the glass, so the capsule's own widget alone would leave them
     *  unsubtracted and read them as backdrop. */
    area?: MonitorRect
    /** Parts of the region some OTHER surface covers (the Activity Island over the
     *  bar), in monitor coordinates: pixels there are not our paint over a backdrop,
     *  and would read as backdrop if they were subtracted. */
    exclude?: MonitorRect[]
    /** Also count the parts of the region we leave SEE-THROUGH — the gaps between the
     *  bar's capsules — toward the typical backdrop (`BackdropStats.mean`), put through
     *  Hyprland's colour pipeline (these blur settings) the way the closed probe does.
     *  For a surface whose skin comes from its backdrop: the bar row reads its skin from
     *  the whole strip, not from wherever its capsules happen to reach — they grow and
     *  shrink with a window title or a tray icon, and the skin followed them
     *  (owner-caught 2026-09-29). Never toward the extremes: no text sits there. */
    seeThrough?: HyprlandBlurParams
    /** Names the images `NIDARA_BACKDROP_DEBUG` writes. */
    tag?: string
    /** Told the rectangle that was measured, in monitor coordinates, and its monitor —
     *  what `probeClosedBackdrop` needs to measure the same place while the surface is
     *  closed. */
    onRegion?: (region: MonitorRect, monitor: Gdk.Monitor) => void
}

/**
 * Hyprland's colour pipeline over a RAW, unblurred patch of a capture — what glass laid
 * there would sit on: the gain per pixel, an average standing in for the blur, then the
 * vibrancy (the order of its shaders; `glass-legibility.ts`). Returns the patch whose
 * top-left corner is (bx, by), `block` pixels a side — or `w`×`h`, for one clipped by
 * the edge of the capture.
 */
function rawBackdrop(px: { data: Uint8Array; stride: number }, block: number, blur: HyprlandBlurParams) {
    // A handful of taps per block is an average of a blurred field; every pixel of it
    // was 17.5 ms on the main thread for a CC-sized panel (measured) — this is ~1/8 the work.
    const inner = Math.max(1, Math.floor(block / 2))
    // Hyprland's `blurprepare` is per channel and per 8-bit value: one table, not a
    // pow() per pixel.
    const prep = new Float64Array(256)
    for (let v = 0; v < 256; v++) prep[v] = hyprlandPrepare({ r: v / 255, g: 0, b: 0 }, blur).r
    return (bx: number, by: number, w = block, h = block): Rgb => {
        let r = 0, g = 0, b = 0, n = 0
        for (let y = by; y < by + h; y += Math.min(inner, h)) {
            for (let x = bx; x < bx + w; x += Math.min(inner, w)) {
                const i = y * px.stride + x * 4
                r += prep[px.data[i]]; g += prep[px.data[i + 1]]; b += prep[px.data[i + 2]]; n++
            }
        }
        return hyprlandVibrancy({ r: r / n, g: g / n, b: b / n }, blur)
    }
}

/** Our paint at or below this (of 255) counts as nothing painted: a see-through pixel. */
const SEE_THROUGH_MAX_ALPHA = 2

/**
 * The backdrop at (x, y) of an OPEN probe where we paint nothing (`ProbeRequest.
 * seeThrough`): the raw capture there, through Hyprland's pipeline, averaged over the
 * blur-sized block (`CLOSED_BLOCK`) that contains the point — clipped at the capture's
 * edge, or the bar (32 px, blocks of 12) would lose its bottom quarter to a block that
 * does not fit. Null unless that whole block is see-through and clear of every excluded rect — a block that touches a
 * capsule's shadow or rim, or another surface, is not raw backdrop. Blocks are cached:
 * every sample point inside one gets the same value, so each counts for its area.
 */
function seeThroughSampler(
    screenPx: { data: Uint8Array; stride: number }, oursPx: { data: Uint8Array; stride: number },
    W: number, H: number, scale: number,
    exclude: { x0: number; y0: number; x1: number; y1: number }[],
    blur: HyprlandBlurParams,
) {
    const block = Math.max(2, Math.round(CLOSED_BLOCK * scale))
    const raw = rawBackdrop(screenPx, block, blur)
    const cols = Math.ceil(W / block)
    const cache = new Map<number, Rgb | null>()
    const compute = (bx: number, by: number): Rgb | null => {
        const w = Math.min(block, W - bx), h = Math.min(block, H - by)
        if (exclude.some(e => bx < e.x1 && bx + w > e.x0 && by < e.y1 && by + h > e.y0)) return null
        for (let y = by; y < by + h; y++)
            for (let x = bx; x < bx + w; x++)
                if (oursPx.data[y * oursPx.stride + x * 4 + 3] > SEE_THROUGH_MAX_ALPHA) return null
        return raw(bx, by, w, h)
    }
    return (x: number, y: number): Rgb | null => {
        const bx = Math.floor(x / block) * block, by = Math.floor(y / block) * block
        const key = (by / block) * cols + bx / block
        let v = cache.get(key)
        if (v === undefined) { v = compute(bx, by); cache.set(key, v) }
        return v
    }
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
    const area = req.area ?? { x: 0, y: 0, width: box.width, height: box.height }
    if (area.width < 4 || area.height < 4) return why(`area ${area.width}x${area.height}`)

    // The capture is in whole logical pixels; the widget's box need not be.
    const x0 = at.x + area.x, y0 = at.y + area.y
    const region: MonitorRect = {
        x: Math.floor(x0), y: Math.floor(y0),
        width: Math.ceil(x0 + area.width) - Math.floor(x0),
        height: Math.ceil(y0 + area.height) - Math.floor(y0),
    }

    const t0 = GLib.get_monotonic_time()
    const captured = await captureRegion(connector, region)
    const tCaptured = GLib.get_monotonic_time()
    if (!captured || !widget.get_mapped()) return why(`no capture of ${JSON.stringify(region)} on ${connector}`)
    req.onRegion?.(region, monitor)
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
    const around: Rgb[] = []
    const dbg = DEBUG_DIR ? new Uint8Array(W * H * 4) : null
    const seeThrough = req.seeThrough ? seeThroughSampler(screenPx, oursPx, W, H, scale, exclude, req.seeThrough) : null
    for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
            if (exclude.some(e => x >= e.x0 && x < e.x1 && y >= e.y0 && y < e.y1)) continue
            const o = y * oursPx.stride + x * 4
            const oa = oursPx.data[o + 3] / 255
            if (oa < MIN_ALPHA && seeThrough) {
                const b = seeThrough(x, y)
                if (b) {
                    around.push(b)
                    if (dbg) {
                        const d = (y * W + x) * 4
                        dbg[d] = b.r * 255; dbg[d + 1] = b.g * 255; dbg[d + 2] = b.b * 255; dbg[d + 3] = 255
                    }
                }
                continue
            }
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
    const stats = backdropStats(out, 64, (step / scale) ** 2, around)   // logical px, like the closed probe
    if (TIMING) console.log(`[BackdropProbe] ${req.tag ?? "probe"}: ${W}x${H}, capture ${((tCaptured - t0) / 1000).toFixed(1)} ms (worker), `
        + `main thread ${((tLooped - tCaptured) / 1000).toFixed(1)} ms = render+readback ${((tRendered - tCaptured) / 1000).toFixed(1)} + ${out.length} samples${seeThrough ? ` + ${around.length} see-through` : ""} ${((tLooped - tRendered) / 1000).toFixed(1)}`)
    if (!stats) return why(`${out.length} glass pixels in ${W}x${H} — too few`)
    return stats
}


/** The side of the square a CLOSED probe averages into one sample, in logical pixels —
 *  about what Hyprland's blur spreads over at `size 2, passes 2`. The statistics are
 *  percentiles of the blurred backdrop, so the exact kernel does not matter; a square
 *  far smaller than the blur would count sharp detail the text never sees. Kept fixed
 *  across the glass materials (#674): the frosted blur spreads further, and a block that
 *  grew with it would outgrow the bar's 32 px strip in the see-through sampler. */
const CLOSED_BLOCK = 12

/** Blocks a closed probe averages, at most. A full-width island mode is ~6700 blocks of
 *  12 px — 12.8 ms on the main thread, measured — so a large rect takes an even
 *  subset of its blocks instead: each block is still a blur-sized average, only fewer
 *  of them, so the percentiles do not drift the way coarser blocks would make them. */
const CLOSED_MAX_BLOCKS = 1500

/**
 * What a CLOSED panel would have behind it where it last opened — so it can open
 * already wearing the right glass instead of correcting itself in front of the user
 * (owner-caught 2026-09-29: a panel appeared in one skin and switched a moment later).
 *
 * With the panel closed there is nothing of ours in that rectangle, so the capture is
 * the backdrop RAW, unblurred. Hyprland's colour pipeline is applied to it (the gain,
 * then an average standing in for the blur, then the vibrancy — the order of its
 * shaders; `glass-legibility.ts`), which gives what the panel's glass would sit on.
 * No offscreen render: cheaper than the open measurement, which still runs once the
 * panel has settled and corrects anything this got wrong.
 *
 * `exclude`: whatever of OURS is on screen there now (another panel, the bar): those
 * pixels are our glass, not the backdrop.
 */
export async function probeClosedBackdrop(req: {
    monitor: Gdk.Monitor
    rect: MonitorRect
    blur: HyprlandBlurParams
    exclude?: MonitorRect[]
    tag?: string
}): Promise<BackdropStats | null> {
    await load()
    if (!shim) return null
    const connector = req.monitor.get_connector()
    if (!connector) return null
    const t0 = GLib.get_monotonic_time()
    const captured = await captureRegion(connector, req.rect)
    if (!captured) return null
    const tCaptured = GLib.get_monotonic_time()
    const W = captured.get_width(), H = captured.get_height()
    const scale = W / req.rect.width
    const px = pixelsOf(captured)
    const block = Math.max(2, Math.round(CLOSED_BLOCK * scale))
    const raw = rawBackdrop(px, block, req.blur)
    const exclude = (req.exclude ?? []).map(e => ({
        x0: (e.x - req.rect.x) * scale, y0: (e.y - req.rect.y) * scale,
        x1: (e.x + e.width - req.rect.x) * scale, y1: (e.y + e.height - req.rect.y) * scale,
    }))
    const out: Rgb[] = []
    const total = Math.floor(W / block) * Math.floor(H / block)
    const every = Math.max(1, Math.ceil(total / CLOSED_MAX_BLOCKS))
    let k = 0
    for (let by = 0; by + block <= H; by += block) {
        for (let bx = 0; bx + block <= W; bx += block) {
            if (k++ % every !== 0) continue
            const cx = bx + block / 2, cy = by + block / 2
            if (exclude.some(e => cx >= e.x0 && cx < e.x1 && cy >= e.y0 && cy < e.y1)) continue
            out.push(raw(bx, by))
        }
    }
    const stats = backdropStats(out, 16, (block / scale) ** 2)
    if (TIMING) console.log(`[BackdropProbe] ${req.tag ?? "closed"} (closed): ${W}x${H}, capture ${((tCaptured - t0) / 1000).toFixed(1)} ms (worker), `
        + `main thread ${((GLib.get_monotonic_time() - tCaptured) / 1000).toFixed(1)} ms, ${out.length} blocks`)
    return stats
}
