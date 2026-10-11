// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { FLUID_CRYSTAL_PRESETS, type FluidCrystalSelection, type FluidCrystalSpec } from "./fluid-crystal"

/**
 * The client half of nidara-material-v1 (`protocols/` at the repository root): every piece
 * of glass tells a compositor of our own (Hyalo, #680) exactly where it is, and the
 * compositor resolves it against what lies behind — the blur, and on a surface whose
 * source asks for it, the whole glass (`GlassParams`: refraction, rim; a tone per pane). A painter
 * then asks `compositorPaintsGlass(itsWidget)` and paints only content and state.
 *
 * A no-op where the compositor does not offer the protocol (Hyprland): nothing is sent,
 * `compositorPaintsGlass` is false, every painter paints as before.
 *
 * What is sent is what the toolkit SHOWS, not the allocation (#684):
 *  - snapshot-time transforms of the ancestors (`GlassPaintTransform` — a panel growing
 *    from its corner is a scale GTK's own geometry never sees),
 *  - how FORMED the glass is (#764): the opacity of the widget and every ancestor — or, for an
 *    ancestor that animates its glass apart from its content (`GlassFormation`: the shell's
 *    ScaleRevealer), what it says. On Hyalo it is not a coverage: glass has no opacity, a pane
 *    appearing materializes (its blur, refraction, tint and rim grow) — never cross-fades,
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
 * The INK (decided by the owner 2026-10-01, #684): the text on Hyalo's glass is white,
 * and turns dark only where the whole backdrop under it is white. Each pane of glass is an
 * ink group; its labels and icons are its boxes; the compositor measures the darkest point
 * under them and says when the group turns dark and back (with hysteresis, never by an
 * average). The pane then carries `INK_DARK_CLASS`, which the bundle's stylesheet gives the
 * light skin's tokens, and a Cairo painter asks `darkInkFor(itsWidget)`.
 *
 * The TONE (owner 2026-10-11): how the glass treats the backdrop under each pane is the
 * reference's own filter, stage by stage as it was measured — saturation, a ceiling, levels, a
 * wash, the ambient — with each kind of pane's values (`GlassTone`, `trackGlassPiece`, the
 * material's table in glass-material.ts). It replaced a tint that thickened per pixel to keep
 * white text legible, and the shadow under the glass that made up what that tint lacked; the
 * Control Center and the Notification Center still lie on a FIXED veil (`trackVeilRegion`).
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
    /** Edge displacement, logical px: every shape's least. */
    refraction: number
    /** A fraction of each shape's shorter side, where that bends more than `refraction`:
     *  large panes lens more than small controls (nidara_material_v1.set_lensing). */
    lensing: number
    rim: number
}

/**
 * How the glass treats the blurred backdrop under a pane (nidara_material_v1.set_tone), stage
 * by stage in this order, on the sRGB-encoded colour: `saturation` about the Rec.709 luma; the
 * `ceiling` (the luma l goes to l·(1 − (1 − ceiling)·l): white lands on it, the mids bend
 * towards it); levels `lift + (gain − lift)·v`; the `wash` laid over; the `ambient` — what
 * surrounds the pane, blurred far wider, through its own levels — lightening what is darker
 * than it, at `ambient` on a large pane (the compositor sizes it: none up to 64 px of shorter
 * side, all of it from 160). Neutral: saturation 1, ceiling 1, lift 0, gain 1, no wash, no
 * ambient.
 */
export type GlassTone = {
    saturation: number
    ceiling: number
    lift: number
    gain: number
    wash: { r: number, g: number, b: number, a: number }
    ambient: number
    ambientLift: number
    ambientGain: number
}

/** What kind of pane a piece of glass is (`trackGlassPiece`): the material gives each its own
 *  tone. `control` — the bar's capsules, the island, buttons: small glass; `panel` — menus,
 *  popovers, the app grid: large floating glass; `controlCenter` and `dock`: the reference's
 *  own two, each measured on its own. */
export type GlassPiece = "control" | "panel" | "controlCenter" | "dock"

/** A pane's tone, and the one it takes while its content is dark (the ink); null: the same. */
export type PaneTone = { tone: GlassTone, inkTone: GlassTone | null }

/** The ink measurement (nidara_material_v1.set_ink): WCAG luminances. A pane whose content
 *  turns dark takes its `inkTone`. */
export type InkParams = {
    darkAbove: number
    lightBelow: number
}

/** A fixed veil under a group of panes (nidara_material_v1.add_veil_region, `trackVeilRegion`):
 *  `strength` black, even under their container, falling over `falloff` logical px outside it
 *  as (1 − d/falloff)^`exponent`. Not measured: the backdrop does not change it. */
export type VeilParams = { strength: number, falloff: number, exponent: number }

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
    /** The tone of a pane of `piece` on this surface; `light` when it wears the light skin by the
     *  system mode (`trackModeGlass`, `trackModeInk`, and not under `trackNoInk`). Asked only
     *  where the compositor paints the glass. */
    tone?(native: Gtk.Native, piece: GlassPiece, light: boolean): PaneTone
    /** The veil of this surface's veil regions (`trackVeilRegion`), or null: none. Asked only
     *  where the compositor paints the glass. */
    veil?(native: Gtk.Native): VeilParams | null
    /** How close, in logical px, two panes of one fusion group (`trackFusionGroup`) must be
     *  to join; 0 or null: no fusion. Asked only where the compositor paints the glass. */
    fusion?(native: Gtk.Native): number | null
    /** 0..1: every fusion group held this far towards its envelope — an instrument, to judge
     *  the shape `pulseFusion` passes through; 0 in the product. */
    fusionHold?(native: Gtk.Native): number
    /** 0..1: every pane held this far formed — an instrument, to judge glass materializing
     *  (#764); 0 in the product. */
    formationHold?(native: Gtk.Native): number
    blur(native: Gtk.Native): { size: number, passes: number }
    onChange(cb: () => void): () => void
}

/** A paint-only transform an ancestor applies in its snapshot (scale about a pivot, then
 *  a translation), in its own coordinates. Implemented by the shell's ScaleRevealer. */
export type PaintTransform = { scale: number, pivotX: number, pivotY: number, dx: number, dy: number }
export interface GlassPaintTransform { glassPaintTransform(): PaintTransform | null }
/** An ancestor that animates its glass apart from its content (#764: the glass forms over the
 *  whole reveal, the content fades in over its second half): how formed the glass under it is,
 *  in place of its opacity. Implemented by the shell's ScaleRevealer. */
export interface GlassFormation { glassFormation(): number }

function formationOf(w: Gtk.Widget): number {
    const f = (w as unknown as Partial<GlassFormation>).glassFormation
    return typeof f === "function" ? f.call(w) : w.get_opacity()
}

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
    material_set_glass(surface: Gdk.Surface, refraction: number, rim: number): void
    material_set_tone?(surface: Gdk.Surface, saturation: number, ceiling: number, lift: number, gain: number,
        washR: number, washG: number, washB: number, washA: number, ambient: number, ambientLift: number,
        ambientGain: number): void
    material_set_ink_tone?(surface: Gdk.Surface, saturation: number, ceiling: number, lift: number, gain: number,
        washR: number, washG: number, washB: number, washA: number, ambient: number, ambientLift: number,
        ambientGain: number): void
    material_set_lensing?(surface: Gdk.Surface, sizeFraction: number): void
    material_clear_glass(surface: Gdk.Surface): void
    material_has_ink?(): boolean
    material_add_ink_box?(surface: Gdk.Surface, id: number, x: number, y: number, w: number, h: number): void
    material_set_ink?(surface: Gdk.Surface, darkAbove: number, lightBelow: number): void
    material_clear_ink?(surface: Gdk.Surface): void
    material_set_ink_func?(func: (surface: Gdk.Surface, id: number, dark: boolean) => void): void
    material_add_veil_region?(surface: Gdk.Surface, x: number, y: number, w: number, h: number, falloff: number,
        strength: number, exponent: number): void
    material_set_fusion?(surface: Gdk.Surface, group: number, spacing: number): void
    /** Since 2026-10-07 (`set_fusion_merge`, inside v1): the library and Hyalo ship together. */
    material_set_fusion_merge?(surface: Gdk.Surface, merge: number): void
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
let nextInkId = 1
/** Containers whose panes of glass turn their ink together (`trackInkGroup`): their id. */
const inkGroups = new WeakMap<Gtk.Widget, number>()

/**
 * Every pane of glass inside `widget` turns its ink together: ONE ink group for all of them,
 * measured over all their content, instead of one per pane. Read when the surface sends its
 * glass, so it holds for panes added later and needs nothing from the components inside.
 * ⚠️ One surface: the compositor measures each surface on its own, so panes of one group on two
 * surfaces could be told opposite things.
 */
export function trackInkGroup(widget: Gtk.Widget): void {
    if (!inkGroups.has(widget)) inkGroups.set(widget, nextInkId++)
}

/** Containers whose panes of glass never take the backdrop's ink (`trackNoInk`). */
const noInk = new WeakSet<Gtk.Widget>()

/** The semantic material selected for a surface, independent of its renderer. */
const fluidCrystalWidgets = new Set<Gtk.Widget>()
const fluidCrystalSpecs = new WeakMap<Gtk.Widget, FluidCrystalSpec>()

/**
 * Give a surface a Fluid Crystal recipe. This is the semantic seam between the kit and the
 * renderer: callers choose a role (`"bar"`, `"panel"`, `"media"`) or provide all four axes,
 * while the active material backend decides how that recipe becomes glass, ink and elevation.
 *
 * This deliberately does not replace the older low-level trackers yet. Existing surfaces can
 * keep their current behaviour while the backend learns the new contract one profile at a time.
 */
export function trackFluidCrystal(widget: Gtk.Widget, selection: FluidCrystalSelection): void {
    const spec = typeof selection === "string"
        ? FLUID_CRYSTAL_PRESETS[selection]
        : Object.freeze({ ...selection })
    fluidCrystalSpecs.set(widget, spec)
    fluidCrystalWidgets.add(widget)
    widget.connect("destroy", () => fluidCrystalWidgets.delete(widget))
}

/** The nearest Fluid Crystal recipe that applies to a native surface, if one is declared. */
export function fluidCrystalFor(native: Gtk.Native): FluidCrystalSpec | null {
    for (const widget of fluidCrystalWidgets) {
        if (widget.get_native() === native) return fluidCrystalSpecs.get(widget) ?? null
    }
    for (let widget: Gtk.Widget | null = native as unknown as Gtk.Widget; widget; widget = widget.get_parent()) {
        const spec = fluidCrystalSpecs.get(widget)
        if (spec) return spec
    }
    return null
}

/**
 * The panes of glass inside `widget` never take the ink: the compositor is given none of
 * their content to measure, so their content stays as the bundle paints it, whatever is
 * behind. Owner, 2026-10-08, after measuring the reference (glass-probe, `macos` set): only
 * glass BUTTONS change their content with the backdrop; the Control Center and the
 * notifications keep white text always, as the reference does, and the dock follows the
 * system mode (`trackModeGlass`).
 */
export function trackNoInk(widget: Gtk.Widget): void {
    noInk.add(widget)
}

/** Whether a pane lies inside a `trackNoInk` container (its own widget included). */
function inkless(e: Entry): boolean {
    for (let w: Gtk.Widget | null = e.widget; w; w = w.get_parent()) if (noInk.has(w)) return true
    return false
}

/** Widgets whose surface's glass follows the system mode (`trackModeGlass`). */
const modeGlass = new Set<Gtk.Widget>()

/**
 * The glass of `widget`'s SURFACE follows the system's light/dark mode, as the reference's
 * dock does (owner, 2026-10-08): dark glass in dark mode, a light veil in light mode — the
 * material decides how (`glassFollowsMode`, glass-material.ts). Its content follows the mode
 * too, which is the bundle's to paint; pair it with `trackNoInk`.
 */
export function trackModeGlass(widget: Gtk.Widget): void {
    modeGlass.add(widget)
    widget.connect("destroy", () => modeGlass.delete(widget))
}

/** Widgets whose surface's INK follows the system mode (`trackModeInk`). */
const modeInk = new Set<Gtk.Widget>()

/**
 * The ink of `widget`'s SURFACE follows the system's light/dark mode instead of the backdrop:
 * dark content (on the ink's light veil) in light mode, light content in dark mode, whatever is
 * behind. The bar (owner, 2026-10-09: "like the dock, by the theme, and later we'll see about
 * automatic" — by the backdrop, each capsule turned on its own, and over a wallpaper bright on one
 * side only one end turned). Only panes that take an ink at all: one under `trackNoInk` keeps its
 * content as the bundle paints it. A popover attached inside it follows too.
 */
export function trackModeInk(widget: Gtk.Widget): void {
    modeInk.add(widget)
    widget.connect("destroy", () => modeInk.delete(widget))
}

/** Containers whose panes of glass are of one kind (`trackGlassPiece`). */
const glassPieces = new WeakMap<Gtk.Widget, GlassPiece>()

/**
 * Every pane of glass inside `widget` is a `piece` — the material gives each kind its own tone
 * (glass-material.ts): the dock, the Control Center, a large panel. The nearest container wins;
 * a pane in none is a `control`, or a `panel` on a popover's surface (a menu, a tooltip).
 */
export function trackGlassPiece(widget: Gtk.Widget, piece: GlassPiece): void {
    glassPieces.set(widget, piece)
}

function pieceOf(e: Entry, native: Gtk.Native): GlassPiece {
    for (let w: Gtk.Widget | null = e.widget; w; w = w.get_parent()) {
        const p = glassPieces.get(w)
        if (p) return p
    }
    return native instanceof Gtk.Popover ? "panel" : "control"
}

/** Whether this surface's ink follows the system mode (`trackModeInk`), as `glassFollowsMode`. */
export function inkFollowsMode(native: Gtk.Native): boolean {
    for (const w of modeInk) if (w.get_native() === native) return true
    for (let w: Gtk.Widget | null = (native as unknown as Gtk.Widget).get_parent(); w; w = w.get_parent()) {
        if (modeInk.has(w)) return true
    }
    return false
}

/** Whether this surface's glass follows the system mode (`trackModeGlass`): it holds such a
 *  widget, or it is a popover attached inside one (the dock's tooltips and menus — a surface
 *  of their own whose content already follows the dock's skin). */
export function glassFollowsMode(native: Gtk.Native): boolean {
    for (const w of modeGlass) if (w.get_native() === native) return true
    for (let w: Gtk.Widget | null = (native as unknown as Gtk.Widget).get_parent(); w; w = w.get_parent()) {
        if (modeGlass.has(w)) return true
    }
    return false
}

/** Fusion groups (`trackFusionGroup`): the container → its group's token, the token → its id. */
const fusionGroups = new WeakMap<Gtk.Widget, object>()
const fusionIds = new WeakMap<object, number>()
let nextFusionId = 1

/**
 * Every pane of glass inside `widget` is drawn with the others of `group` as ONE silhouette:
 * the smooth union of their outlines (#705 step 2). Two of them closer than the material's
 * `fusion` spacing are joined by a bridge that grows as they approach and breaks as they
 * part, and the refraction and the rim follow the whole. `group` lets containers that are not
 * one subtree fuse together (the island's capsule row and its modes); by default the
 * container is its own group. Read when the surface sends its glass. ⚠️ One surface: Hyalo
 * draws each surface's glass on its own, so panes on two surfaces never fuse.
 */
export function trackFusionGroup(widget: Gtk.Widget, group: object = widget): void {
    fusionGroups.set(widget, group)
    if (!fusionIds.has(group)) fusionIds.set(group, nextFusionId++)
}

/** A pulse's shape over its time, 0..1 → 0..1: up over the first 30 %, held, down over the
 *  last 30 %, eased both ways. The hold is the point: a sine touched its peak for an instant,
 *  and the owner saw "capsule and button half fused", never the one capsule (2026-10-07). */
function pulseCurve(t: number): number {
    const ease = (x: number) => x * x * (3 - 2 * x)
    if (t <= 0 || t >= 1) return 0
    if (t < PULSE_EDGE) return ease(t / PULSE_EDGE)
    if (t > 1 - PULSE_EDGE) return ease((1 - t) / PULSE_EDGE)
    return 1
}
const PULSE_EDGE = 0.3

/** The groups changing shape right now (`pulseFusion`): id → its merge now, 0..1. */
const pulses = new Map<number, { start: number, ms: number, boost: number }>()

/**
 * For `ms`, the panes of `group` become ONE: the compositor draws the group towards its
 * envelope — one shape spanning them (`set_fusion_merge`) — up, HELD, and back (`pulseCurve`),
 * so panes that sit apart at rest are one capsule while the group changes — the island trading
 * what its capsule and its chips show — and part again when it settles. Not a wider smooth
 * union: that one can only leave a waist at the join or raise a mound past the edges, whatever
 * its width (measured 18 to 24, 2026-10-07); the envelope is exact at its height and lies
 * between the union and itself on the way. `widget` is any mapped widget of the group's
 * surface: its frames carry the pulse. A pulse asked during another goes on from where that
 * one is, rising again, so a quick second change does not drop the bridge.
 */
export function pulseFusion(group: object, widget: Gtk.Widget, ms: number): void {
    const id = fusionIds.get(group)
    if (!id || ms <= 0) return
    const now = GLib.get_monotonic_time() / 1000
    const running = pulses.get(id)
    if (running) {
        // Rising: go on. Held: the hold starts over. Falling: rise again from the same height
        // (the curve is symmetric, so the rising point of a falling t is 1 − t).
        const t = (now - running.start) / running.ms
        running.start = now - (t > 1 - PULSE_EDGE ? 1 - t : Math.min(t, PULSE_EDGE)) * ms
        running.ms = ms
        return
    }
    const p = { start: now, ms, boost: 0 }
    pulses.set(id, p)
    widget.add_tick_callback(() => {
        const t = (GLib.get_monotonic_time() / 1000 - p.start) / p.ms
        p.boost = pulseCurve(t)
        widget.queue_draw()
        if (t < 1) return GLib.SOURCE_CONTINUE
        pulses.delete(id)
        return GLib.SOURCE_REMOVE
    })
    widget.queue_draw()
}

/** A pane's fusion group: its nearest `trackFusionGroup` container's, or 0 (none). */
function fusionIdOf(e: Entry): number {
    for (let w: Gtk.Widget | null = e.widget; w; w = w.get_parent()) {
        const g = fusionGroups.get(w)
        if (g) return fusionIds.get(g) ?? 0
    }
    return 0
}

/** A pane's ink group: its nearest `trackInkGroup` container's, or its own. */
function inkIdOf(e: Entry): number {
    for (let w = e.widget.get_parent(); w; w = w.get_parent()) {
        const id = inkGroups.get(w)
        if (id !== undefined) return id
    }
    return e.inkId
}

/** The containers whose panes lie on a fixed veil (`trackVeilRegion`). */
const veilRegions = new Set<Gtk.Widget>()

/**
 * The panes of glass inside `widget`'s box lie on one FIXED veil (the material source's
 * `veil`), the size of their container and fading outside it — the darkening a group of panes
 * sits on: no measurement. The Control Center and the Notification Center (owner, 2026-10-11:
 * the reference's Control Center, measured). Declared while the widget is shown; it shares its
 * surface's material (`trackGlass`). Where two regions hold a pane, the one declared first wins.
 */
export function trackVeilRegion(widget: Gtk.Widget): void {
    load()
    veilRegions.add(widget)
    const resend = () => {
        const native = widget.get_native()
        const st = native && natives.get(native)
        if (st) { st.last = ""; queueFrame(native) }
    }
    widget.connect("map", resend)
    widget.connect("unmap", resend)
    widget.connect("destroy", () => veilRegions.delete(widget))
}

/**
 * The veil regions shown on `native`, surface-local (nidara_material_v1.add_veil_region): each
 * is its panes' CONTAINER — it ends where their GLASS ends, not the widget's box, which holds
 * margins — plus as far as that glass refracts (it reads its backdrop from beyond its own
 * edge), so the fall-off starts right at the panel's edge.
 */
function placeVeilRegions(native: Gtk.Native, veil: VeilParams, glass: GlassParams, placed: Placed[]): Rect[] {
    const nw = native as unknown as Gtk.Widget
    const [tx, ty] = native.get_surface_transform()
    const out: Rect[] = []
    for (const widget of veilRegions) {
        if (widget.get_native() !== native || !widget.get_mapped() || !widget.is_drawable()) continue
        const [ok, b] = widget.compute_bounds(nw)
        if (!ok || b.get_width() <= 0 || b.get_height() <= 0) continue
        const box = { x: b.get_x() + tx, y: b.get_y() + ty, w: b.get_width(), h: b.get_height() }
        // Its panes: the shapes whose centre lies in the widget's box, as the compositor counts.
        const panes = placed.filter(s => {
            const cx = s.x + s.w / 2, cy = s.y + s.h / 2
            return cx >= box.x && cx < box.x + box.w && cy >= box.y && cy < box.y + box.h
        })
        if (!panes.length || veil.strength <= 0) continue
        // How far each refracts is the compositor's rule (refraction_of).
        const margin = Math.max(...panes.map(s => Math.max(glass.refraction, glass.lensing * Math.min(s.w, s.h))))
        const x0 = Math.min(...panes.map(s => s.x)) - margin
        const y0 = Math.min(...panes.map(s => s.y)) - margin
        const x1 = Math.max(...panes.map(s => s.x + s.w)) + margin
        const y1 = Math.max(...panes.map(s => s.y + s.h)) + margin
        out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
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

/** Whether the compositor can draw a shape with a pointer (`GlassShape.pointer`). Until it
 *  can, a bubble keeps painting its own glass (`clientPaints`). */
export function compositorDrawsPointers(): boolean {
    return !!shim?.material_add_shape_pointed && !!shim.material_has_ink?.()
}

/** Whether the compositor said the content of the pane of glass `widget` sits in is dark
 *  (the ink). A Cairo painter on the glass asks it with its own widget, as it asks for
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
            // Ids are the process's, never reused: every pane whose group it names turns.
            wl.material_set_ink_func?.((_surface, id, dark) => {
                if (DEBUG) console.log(`[Material] ink event ${id} → ${dark ? "dark" : "light"}`)
                for (const e of entries.values()) if (inkIdOf(e) === id) setDarkInk(e, dark)
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
    pointer?: GlassPointer, fusion?: number, tone?: PaneTone }

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
    for (let p: Gtk.Widget | null = w; p; p = p.get_parent()) opacity *= formationOf(p)
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

function sendTone(f: NonNullable<Shim["material_set_tone"]>, surface: Gdk.Surface, t: GlassTone) {
    f(surface, t.saturation, t.ceiling, t.lift, t.gain, t.wash.r, t.wash.g, t.wash.b, t.wash.a, t.ambient, t.ambientLift,
        t.ambientGain)
}

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
        const p = place(e, native, inkWanted !== null && !e.clientPaints() && !inkless(e))
        if (p.shapes.length && e.clientPaints()) anyClient = true
        const fusion = fusionIdOf(e)
        // Its tone: the light face by the system mode where the surface's GLASS follows it (the
        // dock, `trackModeGlass`), or its ink does (the bar, `trackModeInk`) and the pane takes
        // an ink at all — never under `trackNoInk` there (the Control Center keeps its own).
        const light = glassFollowsMode(native) || (inkFollowsMode(native) && !inkless(e))
        const piece = pieceOf(e, native)
        const tone = source?.tone?.(native, piece, light)
        for (const s of p.shapes) { s.fusion = fusion; s.tone = tone }
        placed.push(...p.shapes)
        for (const box of p.boxes) inkBoxes.push({ id: inkIdOf(e), box })
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
    const veil = paints && shim.material_add_veil_region ? source?.veil?.(native) ?? null : null
    const regions = veil && glass ? placeVeilRegions(native, veil, glass, placed) : []
    // Fusion only where the compositor paints the glass: blurred only, every pane is its own.
    const spacing = paints && shim.material_set_fusion ? source?.fusion?.(native) ?? 0 : 0
    const hold = source?.fusionHold?.(native) ?? 0
    const formationHold = source?.formationHold?.(native) ?? 0
    if (formationHold > 0) for (const s of placed) s.o = formationHold
    const mergeOf = (group: number) => shim?.material_set_fusion_merge
        ? round(Math.max(hold, pulses.get(group)?.boost ?? 0)) : 0
    // Nobody decides this surface's ink any more: its panes are light again, on both ends.
    // Nor anybody's inside a `trackNoInk` container, declared after it was dark.
    for (const e of st.entries) if (!ink || inkless(e)) setDarkInk(e, false)
    const blur = source?.blur(native) ?? { size: 2, passes: 2 }
    const key = JSON.stringify([placed.map(s => [round(s.x), round(s.y), round(s.w), round(s.h), round(s.r), s.e, round(s.o),
        s.clip && [round(s.clip.x), round(s.clip.y), round(s.clip.w), round(s.clip.h)],
        s.pointer && [round(s.pointer.baseX), round(s.pointer.baseY), round(s.pointer.tipX), round(s.pointer.tipY),
            round(s.pointer.width)], spacing > 0 ? s.fusion ?? 0 : 0, spacing > 0 && s.fusion ? mergeOf(s.fusion) : 0,
            paints ? s.tone ?? null : null]),
        paints && glass, blur, spacing,
        ink, ink && inkBoxes.map(b => [b.id, round(b.box.x), round(b.box.y), round(b.box.w), round(b.box.h)]),
        veil, regions.map(r => [round(r.x), round(r.y), round(r.w), round(r.h)])])
    if (key === st.last) return
    st.last = key
    shim.material_begin(surface)
    let fusing = 0
    // `set_tone` holds for the shapes added after it, until the next one (and resets the ink
    // tone, which follows it).
    let toning: PaneTone | undefined
    // No `set_shape_blur`: where the compositor paints the glass its blur is the glass's, mixed
    // by each pane's size (references/hyalo.md → "The blur"); it blurs only a client's own glass.
    for (const s of placed) {
        if (paints && s.tone && s.tone !== toning && shim.material_set_tone) {
            sendTone(shim.material_set_tone, surface, s.tone.tone)
            if (s.tone.inkTone && shim.material_set_ink_tone) sendTone(shim.material_set_ink_tone, surface, s.tone.inkTone)
            toning = s.tone
        }
        // `set_fusion` holds for the shapes added after it, until the next one.
        const f = spacing > 0 ? s.fusion ?? 0 : 0
        if (f !== fusing) {
            shim.material_set_fusion?.(surface, f, spacing)
            const merge = f ? mergeOf(f) : 0
            if (merge > 0) shim.material_set_fusion_merge?.(surface, merge)
            fusing = f
        }
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
        shim.material_set_glass(surface, glass.refraction, glass.rim)
        shim.material_set_lensing?.(surface, glass.lensing)
    } else {
        shim.material_clear_glass(surface)
    }
    if (ink) {
        for (const { id, box } of inkBoxes) shim.material_add_ink_box?.(surface, id, box.x, box.y, box.w, box.h)
        shim.material_set_ink?.(surface, ink.darkAbove, ink.lightBelow)
    } else {
        shim.material_clear_ink?.(surface)
    }
    if (veil) for (const r of regions) shim.material_add_veil_region?.(surface, r.x, r.y, r.w, r.h, veil.falloff, veil.strength, veil.exponent)
    shim.material_commit(surface, blur.size, placed.length ? blur.passes : 0)
    if (DEBUG) console.log(`[Material] ${(native as unknown as Gtk.Widget).get_name()}: ${placed.length} shapes, ${inkBoxes.length} ink boxes, ${regions.length} veil regions, ${paints ? "compositor glass" : "blur only"} ${key}`)
}
