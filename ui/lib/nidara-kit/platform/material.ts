// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

/**
 * The client half of nidara-material-v1 (`protocols/` at the repository root): every piece
 * of glass tells a compositor of our own (Hyalo, #680) exactly where it is, and the
 * compositor resolves it against what lies behind — the blur, and on a surface whose
 * source asks for it, the whole glass (`GlassParams`: refraction, tint, rim). A painter
 * then asks `compositorPaintsGlass(itsWidget)` and paints only content and state.
 *
 * A no-op where the compositor does not offer the protocol (Hyprland): nothing is sent,
 * `compositorPaintsGlass` is false, every painter paints as before.
 *
 * What is sent is what the toolkit SHOWS, not the allocation (#684):
 *  - snapshot-time transforms of the ancestors (`GlassPaintTransform` — a panel growing
 *    from its corner is a scale GTK's own geometry never sees),
 *  - the opacity of the widget and every ancestor (a panel fading in or out),
 *  - the clip of every ancestor whose overflow is hidden (a card scrolled half out of its
 *    list is cut straight, not rounded),
 *  - once per frame, in the frame clock's LAYOUT phase — after GTK allocated, before it
 *    paints and commits, so the shapes land with the buffer they describe. A paint-only
 *    frame (an animation that only queues draws) does not run that phase, so every
 *    frame's before-paint asks for it.
 *
 * Glass inside glass is not declared: a control painted on a panel is not a second pane
 * of glass (the compositor would draw its rim inside the panel). It keeps painting itself.
 *
 * Loaded lazily and tolerated missing, like VisibleRegion: a checkout updated without
 * reinstalling libnidara-wl must not take the shell down. `NIDARA_MATERIAL=0` turns the
 * whole thing off — every painter back to its own glass, the compositor blurring nothing.
 */

/** A shape of glass, in the tracked widget's own coordinates. */
export type GlassShape = {
    x: number, y: number, w: number, h: number,
    radius: number,
    /** Superellipse exponent of each corner; 2 = circular arc. */
    exponent: number,
    /** This shape's own opacity on top of the widget's, 0..1 (a card stacked behind). */
    opacity?: number,
    /** What of it the painter shows, same coordinates (a stacked card's band). */
    clip?: { x: number, y: number, w: number, h: number },
}

/** The glass the compositor paints itself (nidara_material_v1.set_glass). */
export type GlassParams = {
    tint: { r: number, g: number, b: number }
    alphaMin: number
    alphaMax: number
    target: number
    refraction: number
    rim: number
    saturation: number
}

/** Where the bundle's glass comes from: registered once, from its `app.ts`. */
export interface MaterialSource {
    /** The glass the compositor paints on this surface, or null: it only blurs behind
     *  the client's own paint. */
    glass(native: Gtk.Native): GlassParams | null
    blur(native: Gtk.Native): { size: number, passes: number }
    onChange(cb: () => void): () => void
}

/** A paint-only transform an ancestor applies in its snapshot (scale about a pivot, then
 *  a translation), in its own coordinates. Implemented by the shell's ScaleRevealer. */
export type PaintTransform = { scale: number, pivotX: number, pivotY: number, dx: number, dy: number }
export interface GlassPaintTransform { glassPaintTransform(): PaintTransform | null }

type Shim = {
    init(): boolean
    has_material(): boolean
    material_begin(surface: Gdk.Surface): void
    material_add_shape(surface: Gdk.Surface, x: number, y: number, w: number, h: number, r: number, e: number): void
    material_add_shape_clipped?(surface: Gdk.Surface, x: number, y: number, w: number, h: number, r: number, e: number,
        opacity: number, cx: number, cy: number, cw: number, ch: number): void
    material_commit(surface: Gdk.Surface, size: number, passes: number): boolean
    material_set_glass(surface: Gdk.Surface, r: number, g: number, b: number, aMin: number, aMax: number,
        target: number, refraction: number, rim: number, saturation: number): void
    material_clear_glass(surface: Gdk.Surface): void
}

const SHIM_MODULE = "gi://NidaraWl"   // in a variable on purpose: see VisibleRegion.ts
const DISABLED = GLib.getenv("NIDARA_MATERIAL") === "0"
const DEBUG = GLib.getenv("NIDARA_MATERIAL_DEBUG") === "1"

type Entry = {
    /** What paints the glass: its coordinates are the shapes', its opacity is the glass's. */
    widget: Gtk.Widget
    /** The subtree this glass is the pane of (a control inside it is glass on glass);
     *  null for glass that holds nothing of its own. */
    scope: Gtk.Widget | null
    shapes: () => GlassShape[]
    /** Paints its own glass whatever the surface's source says (a shape the protocol
     *  cannot describe, such as a bubble's pointer): the compositor only blurs. */
    clientPaints: boolean
    native: Gtk.Native | null
}
type NativeState = {
    entries: Entry[]
    last: string
    hooked: boolean
    /** Decided at the last flush: the compositor paints this surface's glass. */
    paints: boolean
}

let shim: Shim | null = null
let source: MaterialSource | null = null
let sourceOff: (() => void) | null = null
const entries = new Map<Gtk.Widget, Entry>()
const scopes = new WeakMap<Gtk.Widget, Entry>()
const natives = new Map<Gtk.Native, NativeState>()

/** Register this bundle's glass. Without one, every surface gets a plain blur behind its
 *  own paint. */
export function setMaterialSource(s: MaterialSource): void {
    sourceOff?.()
    source = s
    sourceOff = s.onChange(invalidateAll)
    invalidateAll()
}

/** Whether the compositor paints this widget's glass: its painter then paints only content
 *  and state. Asked from inside a draw function; the same answer the shapes were sent on. */
export function compositorPaintsGlass(widget: Gtk.Widget): boolean {
    const e = entries.get(widget)
    if (!e || !shim || e.clientPaints || !e.native) return false
    return (natives.get(e.native)?.paints ?? false) && !nested(e, e.native)
}

/**
 * Register a piece of glass. `widget` is what paints it (shapes are in its coordinates,
 * its opacity is the glass's); `scope` is the subtree it is the pane of — by default the
 * widget itself, null for glass that holds nothing (a morph's clone drawn over panes that
 * are panes of their own). `shapes` is read every frame the surface draws.
 */
export function trackGlass(widget: Gtk.Widget, shapes: () => GlassShape[],
    opts: { scope?: Gtk.Widget | null, clientPaints?: boolean } = {}): void {
    load()
    const scope = opts.scope === undefined ? widget : opts.scope
    const entry: Entry = { widget, scope, shapes, clientPaints: opts.clientPaints ?? false, native: null }
    entries.set(widget, entry)
    if (scope) scopes.set(scope, entry)
    widget.connect("map", () => attach(entry))
    widget.connect("unmap", () => detach(entry))
    widget.connect("destroy", () => { detach(entry); entries.delete(widget) })
    if (widget.get_mapped()) attach(entry)
}

function load() {
    if (shim || DISABLED || loadStarted) return
    loadStarted = true
    import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init() || !wl.has_material?.()) return
            shim = wl
            console.log(`[Material] nidara-material-v1 ready${wl.material_add_shape_clipped ? "" : " (old libnidara-wl: no fades or clips)"}`)
            invalidateAll()
        })
        .catch(e => console.log(`[Material] unavailable: ${e}`))
}
let loadStarted = false

function glassOf(native: Gtk.Native): GlassParams | null {
    return source?.glass(native) ?? null
}

/** Inside a declared pane of glass of the same surface? */
function nested(e: Entry, native: Gtk.Native): boolean {
    for (let p = (e.scope ?? e.widget).get_parent(); p && (p as unknown) !== native; p = p.get_parent()) {
        const outer = scopes.get(p)
        if (outer && outer !== e && outer.native === native && !outer.clientPaints && outer.widget.get_mapped()) return true
    }
    return false
}

function attach(e: Entry) {
    const native = e.widget.get_native()
    if (!native) return
    if (e.native && e.native !== native) detach(e)
    e.native = native
    const st = stateFor(native)
    if (!st.entries.includes(e)) {
        st.entries.push(e)
        sortByTree(st.entries)
    }
    st.last = ""
    queueFrame(native)
}

function detach(e: Entry) {
    const native = e.native
    if (!native) return
    const st = natives.get(native)
    if (st) {
        st.entries = st.entries.filter(x => x !== e)
        st.last = ""
        queueFrame(native)
    }
    e.native = null
}

function stateFor(native: Gtk.Native): NativeState {
    let st = natives.get(native)
    if (st) return st
    st = { entries: [], last: "", hooked: false, paints: false }
    natives.set(native, st)
    const w = native as unknown as Gtk.Widget
    const hook = () => {
        const clock = native.get_surface()?.get_frame_clock()
        if (!clock || !st) return
        st.last = ""
        if (st.hooked) return
        st.hooked = true
        // A paint-only frame skips LAYOUT unless someone asks for it.
        clock.connect("before-paint", () => clock.request_phase(Gdk.FrameClockPhase.LAYOUT))
        clock.connect("layout", () => flush(native, st!))
    }
    if (w.get_realized()) hook()
    w.connect("realize", hook)
    w.connect("unrealize", () => { if (st) { st.hooked = false; st.last = "" } })
    // A surface shown again (a popover reopened) starts with no material of its own.
    w.connect("map", () => { if (st) st.last = "" })
    w.connect("destroy", () => natives.delete(native))
    return st
}

function queueFrame(native: Gtk.Native) {
    (native as unknown as Gtk.Widget).queue_draw()
}

/** Every painter repaints and every surface resends: the answer to
 *  `compositorPaintsGlass` may have changed. */
function invalidateAll() {
    for (const [native, st] of natives) {
        st.last = ""
        queueFrame(native)
    }
    for (const e of entries.keys()) if (e.get_mapped()) e.queue_draw()
}

/** Depth-first tree order: a later sibling paints over an earlier one, and so must its glass. */
function sortByTree(list: Entry[]) {
    const path = (w: Gtk.Widget): number[] => {
        const out: number[] = []
        for (let c: Gtk.Widget | null = w; c; c = c.get_parent()) {
            let i = 0
            for (let s = c.get_prev_sibling(); s; s = s.get_prev_sibling()) i++
            out.push(i)
        }
        return out.reverse()
    }
    const keys = new Map(list.map(e => [e, path(e.widget)]))
    list.sort((a, b) => {
        const ka = keys.get(a)!, kb = keys.get(b)!
        for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
        return ka.length - kb.length
    })
}

type Rect = { x: number, y: number, w: number, h: number }
type Placed = { x: number, y: number, w: number, h: number, r: number, e: number, o: number, clip: Rect | null }

const ORIGIN = new Graphene.Point()

function offset(from: Gtk.Widget, to: Gtk.Widget): [number, number] | null {
    const [ok, p] = from.compute_point(to, ORIGIN)
    return ok ? [p.x, p.y] : null
}

function transformOf(w: Gtk.Widget): PaintTransform | null {
    const f = (w as unknown as Partial<GlassPaintTransform>).glassPaintTransform
    return typeof f === "function" ? f.call(w) : null
}

function intersect(a: Rect | null, b: Rect): Rect {
    if (!a) return b
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}

/** The shapes of one entry as the surface shows them, surface-local; [] when nothing shows. */
function place(e: Entry, native: Gtk.Native): Placed[] {
    const w = e.widget
    if (!w.get_mapped() || !w.is_drawable()) return []
    let opacity = 1
    for (let p: Gtk.Widget | null = w; p; p = p.get_parent()) opacity *= p.get_opacity()
    if (opacity < 0.005) return []
    const shapes: Placed[] = e.shapes().filter(s => s.w > 0 && s.h > 0).map(s => ({
        x: s.x, y: s.y, w: s.w, h: s.h, r: s.radius, e: s.exponent, o: opacity * (s.opacity ?? 1),
        clip: s.clip ? { ...s.clip } : null,
    }))
    let cur: Gtk.Widget = w
    const move = (dx: number, dy: number) => {
        for (const s of shapes) {
            s.x += dx; s.y += dy
            if (s.clip) { s.clip.x += dx; s.clip.y += dy }
        }
    }
    const nw = native as unknown as Gtk.Widget
    for (let a = w.get_parent(); a && a !== nw; a = a.get_parent()) {
        const t = transformOf(a)
        const clips = a.get_overflow() === Gtk.Overflow.HIDDEN
        if (!t && !clips) continue
        const d = offset(cur, a)
        if (!d) return []
        move(d[0], d[1])
        cur = a
        if (t) {
            const map = (r: { x: number, y: number, w: number, h: number }) => {
                r.x = t.pivotX + (r.x - t.pivotX) * t.scale + t.dx
                r.y = t.pivotY + (r.y - t.pivotY) * t.scale + t.dy
                r.w *= t.scale
                r.h *= t.scale
            }
            for (const s of shapes) {
                map(s)
                s.r *= t.scale
                if (s.clip) map(s.clip)
            }
        }
        // The clip is pushed before the widget's own snapshot transform: unscaled, in its box.
        if (clips) {
            const box = { x: 0, y: 0, w: a.get_width(), h: a.get_height() }
            for (const s of shapes) s.clip = intersect(s.clip, box)
        }
    }
    const d = offset(cur, nw)
    if (!d) return []
    const [tx, ty] = native.get_surface_transform()
    move(d[0] + tx, d[1] + ty)
    return shapes.filter(s => !s.clip || (s.clip.w > 0 && s.clip.h > 0
        && s.clip.x < s.x + s.w && s.x < s.clip.x + s.clip.w
        && s.clip.y < s.y + s.h && s.y < s.clip.y + s.clip.h))
}

const round = (v: number) => Math.round(v * 100) / 100

function flush(native: Gtk.Native, st: NativeState) {
    if (!shim) return
    const surface = native.get_surface()
    if (!surface) return
    const glass = glassOf(native)
    const placed: Placed[] = []
    let anyClient = false
    for (const e of st.entries) {
        if (nested(e, native)) continue
        const p = place(e, native)
        if (p.length && e.clientPaints) anyClient = true
        placed.push(...p)
    }
    // A surface whose glass is partly the client's own is blurred only: the compositor's
    // glass under a client's paint would be two panes in one.
    const paints = glass !== null && !anyClient
    if (paints !== st.paints) {
        // The painters' answer changed: they repaint (their next frame) with the new one.
        st.paints = paints
        for (const e of st.entries) e.widget.queue_draw()
    }
    const blur = source?.blur(native) ?? { size: 2, passes: 2 }
    const key = JSON.stringify([placed.map(s => [round(s.x), round(s.y), round(s.w), round(s.h), round(s.r), s.e, round(s.o),
        s.clip && [round(s.clip.x), round(s.clip.y), round(s.clip.w), round(s.clip.h)]]), paints && glass, blur])
    if (key === st.last) return
    st.last = key
    shim.material_begin(surface)
    for (const s of placed) {
        if (shim.material_add_shape_clipped) {
            const c = s.clip ?? { x: 0, y: 0, w: 0, h: 0 }
            shim.material_add_shape_clipped(surface, s.x, s.y, s.w, s.h, s.r, s.e, Math.min(1, s.o), c.x, c.y, c.w, c.h)
        } else {
            shim.material_add_shape(surface, s.x, s.y, s.w, s.h, s.r, s.e)
        }
    }
    if (paints && glass) {
        const t = glass.tint
        shim.material_set_glass(surface, t.r, t.g, t.b, glass.alphaMin, glass.alphaMax, glass.target,
            glass.refraction, glass.rim, glass.saturation)
    } else {
        shim.material_clear_glass(surface)
    }
    shim.material_commit(surface, blur.size, placed.length ? blur.passes : 0)
    if (DEBUG) console.log(`[Material] ${(native as unknown as Gtk.Widget).get_name()}: ${placed.length} shapes, ${paints ? "compositor glass" : "blur only"} ${key}`)
}
