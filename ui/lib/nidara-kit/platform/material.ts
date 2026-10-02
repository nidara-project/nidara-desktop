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
 * The INK (v3, decided by the owner 2026-10-01, #684): the text on Hyalo's glass is white,
 * and turns dark only where the whole backdrop under it is white. Each pane of glass is an
 * ink group; its labels and icons are its boxes; the compositor measures the darkest point
 * under them and says when the group turns dark and back (with hysteresis, never by an
 * average). The pane then carries `INK_DARK_CLASS`, which the bundle's stylesheet gives the
 * light skin's tokens, and a Cairo painter asks `darkInkFor(itsWidget)`.
 *
 * The SHADOW under the glass (v5, owner 2026-10-02, #684): where the backdrop under a pane is
 * bright in one place and dark in another, the compositor's per-pixel tint left it grey in one
 * part and clear in the other. With a scrim the compositor lays a soft shadow under the glass,
 * even across the pane, and only then — never under a pane over an evenly light backdrop,
 * whose tint is even anyway. A last resort: the least that evens the pane out, the tint doing
 * the rest. A pane gets one of its own; panes that sit together share one through
 * `trackScrimRegion` — the Control Center's is the whole right-hand strip of the screen, fading
 * to the left — and panes that must cast none say so through `trackNoScrim` (the bar's, the
 * dock's, owner 2026-10-02: a halo around them ran over the windows).
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
    /** A pointer spliced into one side (a tooltip's, a menu's), same coordinates: its base
     *  centred on the edge, its tip, its width, the tip's arc and the concave join's. */
    pointer?: GlassPointer,
}

export type GlassPointer = {
    baseX: number, baseY: number, tipX: number, tipY: number,
    width: number, tipRadius: number, baseRadius: number,
}

/** The glass the compositor paints itself (nidara_material_v1.set_glass). */
export type GlassParams = {
    tint: { r: number, g: number, b: number }
    alphaMin: number
    alphaMax: number
    target: number
    /** Edge displacement, logical px: every shape's least. */
    refraction: number
    /** A fraction of each shape's shorter side, where that bends more than `refraction`:
     *  large panes lens more than small controls (nidara_material_v1.set_lensing, v4). */
    lensing: number
    rim: number
    saturation: number
}

/** The ink measurement (nidara_material_v1.set_ink): WCAG luminances, and the veil over a
 *  pane whose content is dark. */
export type InkParams = {
    darkAbove: number
    lightBelow: number
    tint: { r: number, g: number, b: number }
}

/** The shadow under the glass (nidara_material_v1.set_scrim, v5). */
export type ScrimParams = {
    /** The shadow's opacity at its core, at most (the compositor picks less where less does). */
    maxStrength: number
    /** A pane inside no region: its shadow fades over this fraction of its shorter side. */
    sizeFraction: number
    /** A shadow only while the tint the darkest and the brightest point under the panes need
     *  differs by more than this (an opacity): a pane that would be grey in one part and
     *  clear in another. An evenly light backdrop gets an even tint and no shadow. */
    minSpread: number
    /** A region's shadow fades over this many logical px outside it. */
    regionFalloff: number
}

/** The class a pane of glass carries while its content is dark. */
export const INK_DARK_CLASS = "nidara-ink-dark"

/** Where the bundle's glass comes from: registered once, from its `app.ts`. */
export interface MaterialSource {
    /** The glass the compositor paints on this surface, or null: it only blurs behind
     *  the client's own paint. */
    glass(native: Gtk.Native): GlassParams | null
    /** Whether, and how, the compositor decides the ink of this surface's panes; null: the
     *  content stays as the bundle paints it. Asked only where the compositor paints the glass. */
    ink?(native: Gtk.Native): InkParams | null
    /** The shadow under this surface's glass, or null: none. Asked only where the
     *  compositor paints the glass. */
    scrim?(native: Gtk.Native): ScrimParams | null
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
    material_add_shape_pointed?(surface: Gdk.Surface, x: number, y: number, w: number, h: number, r: number, e: number,
        opacity: number, cx: number, cy: number, cw: number, ch: number,
        bx: number, by: number, tx: number, ty: number, pw: number, tipR: number, baseR: number): void
    material_commit(surface: Gdk.Surface, size: number, passes: number): boolean
    material_set_glass(surface: Gdk.Surface, r: number, g: number, b: number, aMin: number, aMax: number,
        target: number, refraction: number, rim: number, saturation: number): void
    material_set_lensing?(surface: Gdk.Surface, sizeFraction: number): void
    material_clear_glass(surface: Gdk.Surface): void
    material_has_ink?(): boolean
    material_add_ink_box?(surface: Gdk.Surface, id: number, x: number, y: number, w: number, h: number): void
    material_set_ink?(surface: Gdk.Surface, darkAbove: number, lightBelow: number, r: number, g: number, b: number): void
    material_clear_ink?(surface: Gdk.Surface): void
    material_set_ink_func?(func: (surface: Gdk.Surface, id: number, dark: boolean) => void): void
    material_set_scrim?(surface: Gdk.Surface, maxStrength: number, sizeFraction: number, minSpread: number): void
    material_add_scrim_region?(surface: Gdk.Surface, x: number, y: number, w: number, h: number, falloff: number): void
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
    /** Paints its own glass whatever the surface's source says (a shape the compositor
     *  cannot draw): the compositor only blurs. Asked every frame. */
    clientPaints: () => boolean
    native: Gtk.Native | null
    /** Its ink group: the compositor's ink event names it. */
    inkId: number
    /** The compositor said its content is dark (`INK_DARK_CLASS` on its pane). */
    darkInk: boolean
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
const byInkId = new Map<number, Entry>()
let nextInkId = 1

/** Which edges of the screen a scrim region reaches past. */
export type ScrimEdges = { left?: boolean, right?: boolean, top?: boolean, bottom?: boolean }
/** `casts: false`: the panes inside cast no shadow at all (`trackNoScrim`). */
type ScrimRegion = { widget: Gtk.Widget, edges: ScrimEdges, casts: boolean }
const scrimRegions = new Map<Gtk.Widget, ScrimRegion>()
/** Far past any screen: the compositor cuts a region to its output. */
const PAST_THE_EDGE = 100000
/** A region's core reaches this far past its widget where it does not reach an edge: the
 *  glass reads its backdrop from beyond its own edge (the refraction), and that must lie on
 *  the even part of the shadow, not on its fade. */
const SCRIM_MARGIN = 32

/**
 * One shadow under every pane of glass inside `widget`'s box (v5), instead of one each: panes
 * side by side lie on one even shadow, fading only outside it. `edges` says which edges of the
 * screen the region reaches past — the Control Center's is the screen's whole right-hand strip
 * (right, top and bottom), so its shadow fades only toward the left. Declared while the
 * widget is shown; it shares its surface's material (`trackGlass`). Where two regions hold a
 * pane, the one declared first wins.
 */
export function trackScrimRegion(widget: Gtk.Widget, edges: ScrimEdges): void {
    addScrimRegion({ widget, edges, casts: true })
}

/**
 * The panes of glass inside `widget`'s box cast no shadow (v5) — not a shared one, not one of
 * their own. The bar and the dock, for now (owner, 2026-10-02): a halo around their glass ran
 * over the windows, and a band hugging them could not fade without reaching the windows
 * either. Declare it BEFORE any region that could also hold those panes: the first one wins.
 */
export function trackNoScrim(widget: Gtk.Widget): void {
    addScrimRegion({ widget, edges: {}, casts: false })
}

function addScrimRegion(r: ScrimRegion): void {
    load()
    const widget = r.widget
    scrimRegions.set(widget, r)
    const resend = () => {
        const native = widget.get_native()
        const st = native && natives.get(native)
        if (st) { st.last = ""; queueFrame(native) }
    }
    widget.connect("map", resend)
    widget.connect("unmap", resend)
    widget.connect("destroy", () => scrimRegions.delete(widget))
}

/** The scrim regions shown on `native`, surface-local, each with its falloff: negative for
 *  one that casts nothing (nidara_material_v1.add_scrim_region). */
function placeScrimRegions(native: Gtk.Native, scrim: ScrimParams): (Rect & { falloff: number })[] {
    const nw = native as unknown as Gtk.Widget
    const [tx, ty] = native.get_surface_transform()
    const out: (Rect & { falloff: number })[] = []
    for (const { widget, edges, casts } of scrimRegions.values()) {
        if (widget.get_native() !== native || !widget.get_mapped() || !widget.is_drawable()) continue
        const [ok, b] = widget.compute_bounds(nw)
        if (!ok || b.get_width() <= 0 || b.get_height() <= 0) continue
        const x0 = edges.left ? -PAST_THE_EDGE : b.get_x() + tx - SCRIM_MARGIN
        const y0 = edges.top ? -PAST_THE_EDGE : b.get_y() + ty - SCRIM_MARGIN
        const x1 = edges.right ? PAST_THE_EDGE : b.get_x() + tx + b.get_width() + SCRIM_MARGIN
        const y1 = edges.bottom ? PAST_THE_EDGE : b.get_y() + ty + b.get_height() + SCRIM_MARGIN
        out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, falloff: casts ? scrim.regionFalloff : -1 })
    }
    return out
}

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
    if (!e || !shim || e.clientPaints() || !e.native) return false
    return (natives.get(e.native)?.paints ?? false) && !nested(e, e.native)
}

/** Whether the compositor can draw a shape with a pointer (`GlassShape.pointer`, protocol
 *  v3). Until it can, a bubble keeps painting its own glass (`clientPaints`). */
export function compositorDrawsPointers(): boolean {
    return !!shim?.material_add_shape_pointed && !!shim.material_has_ink?.()
}

/** Whether the compositor said the content of the pane of glass `widget` sits in is dark
 *  (the ink, v3). A Cairo painter on the glass asks it with its own widget, as it asks for
 *  the skin; false outside any pane, and wherever the compositor does not decide the ink. */
export function darkInkFor(widget: Gtk.Widget | null): boolean {
    for (let w: Gtk.Widget | null = widget; w; w = w.get_parent()) {
        const e = scopes.get(w)
        if (e && !e.clientPaints()) return e.darkInk
    }
    return false
}

/** A Cairo painter does not repaint when an ancestor is queued: each one is asked. */
function redrawSubtree(w: Gtk.Widget) {
    w.queue_draw()
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) redrawSubtree(c)
}

function setDarkInk(e: Entry, dark: boolean) {
    if (e.darkInk === dark) return
    e.darkInk = dark
    const pane = e.scope ?? e.widget
    if (dark) pane.add_css_class(INK_DARK_CLASS)
    else pane.remove_css_class(INK_DARK_CLASS)
    redrawSubtree(pane)
    if (DEBUG) console.log(`[Material] ink ${e.inkId} (${pane.get_name() || pane.constructor.name}): ${dark ? "dark" : "light"}`)
}

/**
 * Register a piece of glass. `widget` is what paints it (shapes are in its coordinates,
 * its opacity is the glass's); `scope` is the subtree it is the pane of — by default the
 * widget itself, null for glass that holds nothing (a morph's clone drawn over panes that
 * are panes of their own). `shapes` is read every frame the surface draws.
 */
export function trackGlass(widget: Gtk.Widget, shapes: () => GlassShape[],
    opts: { scope?: Gtk.Widget | null, clientPaints?: boolean | (() => boolean) } = {}): void {
    load()
    const scope = opts.scope === undefined ? widget : opts.scope
    const cp = opts.clientPaints
    const entry: Entry = { widget, scope, shapes, clientPaints: typeof cp === "function" ? cp : () => cp ?? false, native: null,
        inkId: nextInkId++, darkInk: false }
    entries.set(widget, entry)
    byInkId.set(entry.inkId, entry)
    if (scope) scopes.set(scope, entry)
    widget.connect("map", () => attach(entry))
    widget.connect("unmap", () => detach(entry))
    widget.connect("destroy", () => { detach(entry); entries.delete(widget); byInkId.delete(entry.inkId) })
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
            wl.material_set_ink_func?.((_surface, id, dark) => {
                const e = byInkId.get(id)
                if (e) setDarkInk(e, dark)
            })
            const ink = wl.material_has_ink?.() ? ", ink" : wl.material_add_ink_box ? "" : " (old libnidara-wl: no ink)"
            console.log(`[Material] nidara-material-v1 ready${wl.material_add_shape_clipped ? "" : " (old libnidara-wl: no fades or clips)"}${ink}`)
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
        if (outer && outer !== e && outer.native === native && !outer.clientPaints() && outer.widget.get_mapped()) return true
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
type Placed = { x: number, y: number, w: number, h: number, r: number, e: number, o: number, clip: Rect | null,
    pointer?: GlassPointer }

/** Past this many boxes a pane sends one, their union: a stricter measure, never a looser one. */
const MAX_INK_BOXES_PER_PANE = 8

/** Where a pane's content sits, in the glass widget's coordinates: every LEAF it draws on
 *  its glass — labels with text, icons, Cairo areas, CSS-painted boxes like the workspace
 *  dots — what changes colour with the ink. Not the glass's own painter. A widget type
 *  list would miss whatever it does not name (the dots did); an empty spacer counted as
 *  content only makes the measure stricter. A nested pane of glass is the outer pane's
 *  content (it is not declared, and follows the outer pane's ink). */
function contentBoxes(e: Entry): Rect[] {
    const out: Rect[] = []
    const visit = (w: Gtk.Widget) => {
        if (!w.is_drawable() || w === e.widget) return
        const leaf = w.get_first_child() === null || w instanceof Gtk.Label
        if (leaf) {
            if (w instanceof Gtk.Label && w.get_text() === "") return
            const [ok, b] = w.compute_bounds(e.widget)
            if (ok && b.get_width() > 0 && b.get_height() > 0)
                out.push({ x: b.get_x(), y: b.get_y(), w: b.get_width(), h: b.get_height() })
            return
        }
        for (let c = w.get_first_child(); c; c = c.get_next_sibling()) visit(c)
    }
    if (e.scope) visit(e.scope)
    if (out.length <= MAX_INK_BOXES_PER_PANE) return out
    const x0 = Math.min(...out.map(r => r.x)), y0 = Math.min(...out.map(r => r.y))
    const x1 = Math.max(...out.map(r => r.x + r.w)), y1 = Math.max(...out.map(r => r.y + r.h))
    return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]
}

const ORIGIN = new Graphene.Point()

function offset(from: Gtk.Widget, to: Gtk.Widget): [number, number] | null {
    const [ok, p] = from.compute_point(to, ORIGIN)
    return ok ? [p.x, p.y] : null
}

function transformOf(w: Gtk.Widget): PaintTransform | null {
    const f = (w as unknown as Partial<GlassPaintTransform>).glassPaintTransform
    return typeof f === "function" ? f.call(w) : null
}

/** A NEW rectangle, always: every shape and box of an entry gets its own clip, and `move`
 *  shifts each one — a clip shared between two of them moved twice (the notification's
 *  ended 4× off-screen once its three ink boxes shared it, 2026-10-02). */
function intersect(a: Rect | null, b: Rect): Rect {
    if (!a) return { x: b.x, y: b.y, w: b.w, h: b.h }
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}

/** The shapes of one entry as the surface shows them, surface-local, and (with `ink`) where
 *  its content sits; nothing when nothing shows. */
function place(e: Entry, native: Gtk.Native, ink = false): { shapes: Placed[], boxes: Rect[] } {
    const none = { shapes: [], boxes: [] }
    const w = e.widget
    if (!w.get_mapped() || !w.is_drawable()) return none
    let opacity = 1
    for (let p: Gtk.Widget | null = w; p; p = p.get_parent()) opacity *= p.get_opacity()
    if (opacity < 0.005) return none
    const shapes: Placed[] = e.shapes().filter(s => s.w > 0 && s.h > 0).map(s => ({
        x: s.x, y: s.y, w: s.w, h: s.h, r: s.radius, e: s.exponent, o: opacity * (s.opacity ?? 1),
        clip: s.clip ? { ...s.clip } : null, pointer: s.pointer ? { ...s.pointer } : undefined,
    }))
    // The content goes through every transform and clip the shapes go through: a box is cut
    // where the pane is (a label scrolled out of its list is no content of the pane).
    const boxes: Placed[] = (ink && shapes.length ? contentBoxes(e) : []).map(b => ({
        ...b, r: 0, e: 2, o: 1, clip: null,
    }))
    let cur: Gtk.Widget = w
    const move = (dx: number, dy: number) => {
        for (const s of [...shapes, ...boxes]) {
            s.x += dx; s.y += dy
            if (s.clip) { s.clip.x += dx; s.clip.y += dy }
            if (s.pointer) { s.pointer.baseX += dx; s.pointer.baseY += dy; s.pointer.tipX += dx; s.pointer.tipY += dy }
        }
    }
    const nw = native as unknown as Gtk.Widget
    for (let a = w.get_parent(); a && a !== nw; a = a.get_parent()) {
        const t = transformOf(a)
        const clips = a.get_overflow() === Gtk.Overflow.HIDDEN
        if (!t && !clips) continue
        const d = offset(cur, a)
        if (!d) return none
        move(d[0], d[1])
        cur = a
        if (t) {
            const map = (r: { x: number, y: number, w: number, h: number }) => {
                r.x = t.pivotX + (r.x - t.pivotX) * t.scale + t.dx
                r.y = t.pivotY + (r.y - t.pivotY) * t.scale + t.dy
                r.w *= t.scale
                r.h *= t.scale
            }
            for (const s of [...shapes, ...boxes]) {
                map(s)
                s.r *= t.scale
                if (s.clip) map(s.clip)
                const p = s.pointer
                if (p) {
                    p.baseX = t.pivotX + (p.baseX - t.pivotX) * t.scale + t.dx
                    p.baseY = t.pivotY + (p.baseY - t.pivotY) * t.scale + t.dy
                    p.tipX = t.pivotX + (p.tipX - t.pivotX) * t.scale + t.dx
                    p.tipY = t.pivotY + (p.tipY - t.pivotY) * t.scale + t.dy
                    p.width *= t.scale; p.tipRadius *= t.scale; p.baseRadius *= t.scale
                }
            }
        }
        // The clip is pushed before the widget's own snapshot transform: unscaled, in its box.
        if (clips) {
            const box = { x: 0, y: 0, w: a.get_width(), h: a.get_height() }
            for (const s of [...shapes, ...boxes]) s.clip = intersect(s.clip, box)
        }
    }
    const d = offset(cur, nw)
    if (!d) return none
    const [tx, ty] = native.get_surface_transform()
    move(d[0] + tx, d[1] + ty)
    const shows = (s: Placed) => !s.clip || (s.clip.w > 0 && s.clip.h > 0
        && s.clip.x < s.x + s.w && s.x < s.clip.x + s.clip.w
        && s.clip.y < s.y + s.h && s.y < s.clip.y + s.clip.h)
    return {
        shapes: shapes.filter(shows),
        boxes: boxes.filter(shows).map(b => b.clip ? intersect(b.clip, b) : { x: b.x, y: b.y, w: b.w, h: b.h }),
    }
}

const round = (v: number) => Math.round(v * 100) / 100

function flush(native: Gtk.Native, st: NativeState) {
    if (!shim) return
    const surface = native.get_surface()
    if (!surface) return
    const glass = glassOf(native)
    const inkWanted = glass !== null && !!shim.material_has_ink?.() ? source?.ink?.(native) ?? null : null
    const placed: Placed[] = []
    const inkBoxes: { id: number, box: Rect }[] = []
    let anyClient = false
    for (const e of st.entries) {
        if (nested(e, native)) continue
        const p = place(e, native, inkWanted !== null && !e.clientPaints())
        if (p.shapes.length && e.clientPaints()) anyClient = true
        placed.push(...p.shapes)
        for (const box of p.boxes) inkBoxes.push({ id: e.inkId, box })
    }
    // A surface whose glass is partly the client's own is blurred only: the compositor's
    // glass under a client's paint would be two panes in one.
    const paints = glass !== null && !anyClient
    if (paints !== st.paints) {
        // The painters' answer changed: they repaint (their next frame) with the new one.
        st.paints = paints
        for (const e of st.entries) e.widget.queue_draw()
    }
    const ink = paints ? inkWanted : null
    const scrim = paints && shim.material_set_scrim ? source?.scrim?.(native) ?? null : null
    const regions = scrim ? placeScrimRegions(native, scrim) : []
    // Nobody decides this surface's ink any more: its panes are light again, on both ends.
    if (!ink) for (const e of st.entries) setDarkInk(e, false)
    const blur = source?.blur(native) ?? { size: 2, passes: 2 }
    const key = JSON.stringify([placed.map(s => [round(s.x), round(s.y), round(s.w), round(s.h), round(s.r), s.e, round(s.o),
        s.clip && [round(s.clip.x), round(s.clip.y), round(s.clip.w), round(s.clip.h)],
        s.pointer && [round(s.pointer.baseX), round(s.pointer.baseY), round(s.pointer.tipX), round(s.pointer.tipY),
            round(s.pointer.width)]]), paints && glass, blur,
        ink, ink && inkBoxes.map(b => [b.id, round(b.box.x), round(b.box.y), round(b.box.w), round(b.box.h)]),
        scrim, regions.map(r => [round(r.x), round(r.y), round(r.w), round(r.h), round(r.falloff)])])
    if (key === st.last) return
    st.last = key
    shim.material_begin(surface)
    for (const s of placed) {
        const p = s.pointer
        if (p && shim.material_add_shape_pointed) {
            const c = s.clip ?? { x: 0, y: 0, w: 0, h: 0 }
            shim.material_add_shape_pointed(surface, s.x, s.y, s.w, s.h, s.r, s.e, Math.min(1, s.o), c.x, c.y, c.w, c.h,
                p.baseX, p.baseY, p.tipX, p.tipY, p.width, p.tipRadius, p.baseRadius)
        } else if (shim.material_add_shape_clipped) {
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
        shim.material_set_lensing?.(surface, glass.lensing)
    } else {
        shim.material_clear_glass(surface)
    }
    if (ink) {
        for (const { id, box } of inkBoxes) shim.material_add_ink_box?.(surface, id, box.x, box.y, box.w, box.h)
        shim.material_set_ink?.(surface, ink.darkAbove, ink.lightBelow, ink.tint.r, ink.tint.g, ink.tint.b)
    } else {
        shim.material_clear_ink?.(surface)
    }
    if (scrim) {
        for (const r of regions) shim.material_add_scrim_region?.(surface, r.x, r.y, r.w, r.h, r.falloff)
        shim.material_set_scrim?.(surface, scrim.maxStrength, scrim.sizeFraction, scrim.minSpread)
    } else {
        shim.material_set_scrim?.(surface, 0, 0, 0)
    }
    shim.material_commit(surface, blur.size, placed.length ? blur.passes : 0)
    if (DEBUG) console.log(`[Material] ${(native as unknown as Gtk.Widget).get_name()}: ${placed.length} shapes, ${inkBoxes.length} ink boxes, ${regions.length} scrim regions, ${paints ? "compositor glass" : "blur only"} ${key}`)
}
