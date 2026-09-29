import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"
import hyprlandState from "../core/HyprlandState"
import Wallpaper from "../core/WallpaperManager"
import Gdk from "gi://Gdk?version=4.0"
import { probeBackdrop, probeClosedBackdrop, type MonitorRect } from "./BackdropProbe"
import { SlicedCairoArea } from "../../lib/sliced-cairo"
import { LAYER_IGNORE_ALPHA } from "../../lib/nidara-kit/platform/theme-tokens"
import {
    decideGlass, decideGlassByBackdrop, mergeBackdropStats, NIDARA_BLUR,
    type GlassDecision, type BackdropStats, type HyprlandBlurParams, type GlassContent,
} from "../../lib/nidara-kit/platform/glass-legibility"

/**
 * ADAPTIVE GLASS (#673) — each shell surface keeps its text legible over whatever is
 * behind it, by itself.
 *
 * A surface (the bar, the open panel, the island, the app grid, the dock) is REGISTERED here
 * with its root widget and the glass slider that is its floor. On the events that can
 * change what is behind it — it settles open, a window opens/closes/moves/goes
 * fullscreen, the workspace or the wallpaper changes, the theme changes — it is
 * measured (`BackdropProbe.ts`) and the rule (`decideGlass`, in the kit, held to its
 * numbers by `scripts/dev/glass-legibility-probe.ts`) says what it wears:
 *
 *   A. its own skin, its tint thickened from the slider up to the ceiling; or
 *   B. the other skin, if the ceiling is not enough.
 *
 * ── HOW A PAINTER FINDS OUT ─────────────────────────────────────────────────
 *
 * It asks with its OWN widget: `glassAlphaFor(widget, role)` and
 * `chromeIsDarkFor(widget)` walk up to the registered surface that contains it. So
 * nothing is threaded through constructors, and a popover (a tooltip, a context
 * menu) — parented to a widget inside the surface — follows its surface for free.
 * CSS follows through a class on the root (`nidara-skin-dark` / `nidara-skin-light`,
 * only while flipped), which the token engine scopes a full token set to
 * (`generateSkinFlipScope`).
 *
 * ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
 *
 * - Go below the user's slider. The slider is a floor now, not the value.
 * - Measure on a timer. Events only: a timer would be the continuous GPU work the
 *   animation rule bans. What changes behind a surface WITHOUT an event (a video, a
 *   scrolling page) is caught at the next event, not live.
 * - Measure while it is moving (opening, closing, its own tint animating): the
 *   capture and the offscreen render would describe different frames.
 */

export type GlassRole = "bar" | "overlay" | "dock"

/** After an event, before measuring. Longer than the compositor's own animations
 *  on purpose (workspaces slide for 600 ms, layers fade in for 300–400 ms): a
 *  capture taken mid-slide or mid-fade shows the screen in between two states, and
 *  a layer fading in is composited THINNER than it is — which reads as a brighter
 *  backdrop. Measured 2026-09-29: the bar's first probe, taken inside its own
 *  fade-in, recovered (+17, 0, +32) over the real backdrop and flipped it. */
const DEBOUNCE_MS = 800
/** How long a tint change takes. Apple animates the Liquid Glass flip; a jump of
 *  0.1 in alpha across a whole panel reads as a flash without this. */
const TRANSITION_MS = 200
const TRANSITION_STEP_MS = 16
/** After `map`, before the first frame of the surface is certainly on screen: a
 *  capture taken sooner shows the screen WITHOUT it, and subtracting our paint
 *  from that reads nonsense. Overlays are measured from their reveal's end
 *  instead (`remeasure`), so this only governs the always-on ones. */
const MAP_SETTLE_MS = 1000
/** awww's default `--transition-duration` (3 s; WallpaperManager passes none), plus
 *  margin. */
const WALLPAPER_TRANSITION_MS = 3500
/** After a surface changes what it wears, how long before it may be measured again.
 *  A flip restyles the CSS on the next frame and repaints the Cairo glass on the next
 *  draw — not necessarily the same one — and the offscreen render can still hand back
 *  a DrawingArea's previous node. A probe inside that window compares two different
 *  surfaces and reads nonsense: caught 2026-09-29, a capture with light glass and
 *  white text against a render with dark glass, which recovered a near-white backdrop
 *  behind a bar sitting on purple. */
const QUIET_AFTER_CHANGE_MS = 600
/** Unmeasurable probes retried after 1.6, 3.2, 6.4 s — then left to the next event. */
const MAX_RETRIES = 3

export interface GlassSurfaceOpts {
    /** For logs and `dumpState`. */
    id: string
    /** The widget whose subtree wears the decision, and whose paint is subtracted
     *  from the capture. */
    root: Gtk.Widget
    /** Which glass slider is this surface's floor. A getter for a surface whose
     *  glass changes role (the island: a bar capsule at rest, a panel when open). */
    role: GlassRole | (() => GlassRole)
    /** What to measure, when it is not the whole root: the island's surface is the
     *  whole monitor, and what it paints is the capsule or the open mode. Null =
     *  nothing to measure right now. */
    probe?: () => Gtk.Widget | null
    /** The part of the probed widget that is glass, in its own coordinates, when that
     *  is not its whole box (see `ProbeRequest.area`). The dock: its layout spans the
     *  monitor and the glass is the capsule. */
    probeArea?: () => MonitorRect | null
    /** Where the root's window starts on its monitor (see `ProbeRequest`). */
    windowOrigin?: () => { x: number; y: number }
    /** False while the surface should not be measured even though it is mapped
     *  (mid-animation). Defaults to "mapped". */
    settled?: () => boolean
    /** Mapped, but nowhere on screen (the dock slid away by auto-hide): measured like a
     *  CLOSED panel, where it last was, so it comes back already right. */
    hidden?: () => boolean
    /** Where it stands when shown, known while it is hidden — so it can be measured
     *  there without ever having been measured open. The auto-hidden dock needs it: it
     *  is on screen only while the pointer is on it, which is never `settled`, so it
     *  would never learn a `lastRect` from an open measurement. */
    restsAt?: () => { monitor: Gdk.Monitor; rect: MonitorRect } | null
    /** What has to stay readable on it (`GlassContent`). Default `text`; the dock
     *  carries only marks. */
    content?: GlassContent
    /** Areas another layer covers ABOVE this surface (the Activity Island over the
     *  bar and its panels), in monitor coordinates: subtracting our paint there
     *  would read the other layer as backdrop. */
    exclude?: () => MonitorRect[]
    /** Surfaces that READ as one piece decide as one: same group, one decision, taken
     *  from all their backdrops together. The island's capsule sits in the bar's row
     *  and is part of the bar to the eye, so while it is compact it joins the bar's
     *  group; open, it is a panel of its own (null). Without this, a pale stretch of
     *  wallpaper under the bar's left end flipped the bar to light and left the
     *  island's capsule dark in the middle of it (2026-09-29). */
    group?: () => string | null
    /** It carries a `GlassHalo` (the CC): a diffuse container under its pieces of glass,
     *  which is the FIRST step of thickening — see `haloAlphaFor`. */
    halo?: boolean
    /** The skin comes from the BACKDROP, not from the mode — the bar row, as macOS's
     *  menu bar (#676): white ink over a dark top edge, black over a light one. In a
     *  group, one member saying so is enough (the bar speaks for the island's capsule).
     *  Such a surface reads its typical backdrop over its WHOLE box, the gaps it leaves
     *  see-through included (`ProbeRequest.seeThrough`): its skin must not depend on how
     *  far its glass happens to reach. */
    skinFromBackdrop?: boolean
}

interface Surface extends GlassSurfaceOpts {
    decision: GlassDecision | null
    shownAlpha: number | null
    lastStats: BackdropStats | null
    lastProbeUs: number
    seq: number
    animId: number | null
    retries: number
    quietUntilUs: number
    /** Where it was last measured OPEN, so it can be measured closed (see
     *  `measureClosed`). Null until it has been open once. */
    lastRect: MonitorRect | null
    lastMonitor: Gdk.Monitor | null
    /** When the last CLOSED measurement landed (µs). */
    closedAtUs: number
    /** A measurement was due while it was not `settled`: owed once it comes to rest. */
    missed: boolean
}

const surfaces = new Map<Gtk.Widget, Surface>()

// ── lookup, for painters ────────────────────────────────────────────────────

function surfaceOf(widget: Gtk.Widget | null): Surface | null {
    for (let w: Gtk.Widget | null = widget; w; w = w.get_parent()) {
        const s = surfaces.get(w)
        if (s) return s
    }
    return null
}

const floorOf = (role: GlassRole) =>
    role === "bar" ? Theme.barOpacity : role === "dock" ? Theme.dockOpacity : Theme.overlayOpacity

// ── the halo (`GlassHalo`, the CC's container) ──────────────────────────────
//
// A surface with a halo is decided as ONE glass of effective alpha `e`, and `e` is
// split between the halo (`c`, under everything) and its pieces (`a`, each tile):
// `e = 1 − (1−a)(1−c)` — same tint, so that is exact. The halo takes the first share
// (owner, 2026-09-29): it is always there at `HALO_REST`, it is what thickens first, up
// to `HALO_MAX`, and only past that do the tiles gain body.

/** The halo at rest — always there: the panel opens with its shadow, whatever is behind. */
export const HALO_REST = 0.12
/** …and at most: under the layer's `ignore_alpha`, so Hyprland never blurs behind it
 *  and it stays a shadow, not a panel. */
export const HALO_MAX = LAYER_IGNORE_ALPHA - 0.01

/** The least a surface can wear: its slider, or — with a halo — the slider over the
 *  halo at rest. */
function floorFor(s: Surface): number {
    const floor = floorOf(roleOf(s))
    return s.halo ? 1 - (1 - floor) * (1 - HALO_REST) : floor
}

/** The halo's share of an effective alpha: all of it the tiles do not need to add,
 *  between rest and max. */
const haloShare = (e: number, floor: number) =>
    Math.min(HALO_MAX, Math.max(HALO_REST, 1 - (1 - e) / (1 - floor)))
/** On screen: mapped, and not slid away. */
const shown = (s: Surface) => s.root.get_mapped() && !s.hidden?.()
const roleOf = (s: Surface): GlassRole => typeof s.role === "function" ? s.role() : s.role

/**
 * The opacity a glass painter inside `widget` should use for `role` — the user's
 * slider, or more if the surface it sits in has thickened. Outside any registered
 * surface: the slider, exactly as before.
 */
export function glassAlphaFor(widget: Gtk.Widget | null, role: GlassRole): number {
    const floor = floorOf(role)
    const s = surfaceOf(widget)
    if (s?.halo) {
        // The tiles' share: what is left of the effective alpha once the halo has its own.
        const e = s.shownAlpha ?? floorFor(s)
        return Math.max(floor, 1 - (1 - e) / (1 - haloShare(e, floor)))
    }
    return s?.shownAlpha != null ? Math.max(floor, s.shownAlpha) : floor
}

/** The alpha of the `GlassHalo` inside `widget`'s surface: `HALO_REST` until the
 *  backdrop asks for more, `HALO_MAX` at most. 0 outside a surface with a halo. */
export function haloAlphaFor(widget: Gtk.Widget | null): number {
    const s = surfaceOf(widget)
    if (!s?.halo) return 0
    return haloShare(s.shownAlpha ?? floorFor(s), floorOf(roleOf(s)))
}

/** The skin a shell-chrome painter inside `widget` should paint: the shell's own
 *  (`Theme.chromeIsDark`), unless its surface has flipped. */
export function chromeIsDarkFor(widget: Gtk.Widget | null): boolean {
    const s = surfaceOf(widget)
    return s?.decision ? s.decision.isDark : Theme.chromeIsDark
}

// ── applying a decision ─────────────────────────────────────────────────────

/** Cairo painters do not repaint when an ancestor is queued — each DrawingArea
 *  has to be asked. The subtrees are panels, a few hundred widgets at most. */
function redrawSubtree(w: Gtk.Widget) {
    // A SlicedCairoArea (the dock's capsule) is no DrawingArea, and re-checks its
    // cached textures on queue_draw the same way.
    // A GlassHalo repaints nothing on its own either (duck-typed: GlassHalo imports this file).
    if (w instanceof Gtk.DrawingArea || w instanceof SlicedCairoArea || (w as any).isGlassHalo) w.queue_draw()
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) redrawSubtree(c)
}

function applySkinClass(s: Surface) {
    const flipped = s.decision !== null && s.decision.isDark !== Theme.chromeIsDark
    s.root.remove_css_class("nidara-skin-dark")
    s.root.remove_css_class("nidara-skin-light")
    if (flipped) s.root.add_css_class(s.decision!.isDark ? "nidara-skin-dark" : "nidara-skin-light")
}

/** One log line per SKIN change — never per measurement: a flip is rare and visible,
 *  and "why did the bar go light over nothing" (owner, 2026-09-29, intermittent, not
 *  reproduced on demand) can only be answered by what it saw at that moment. With
 *  `NIDARA_BACKDROP_DEBUG` the probe's images carry the same tag. */
function logFlip(s: Surface, prev: GlassDecision | null, next: GlassDecision, why: string, stats: BackdropStats | null) {
    // A change of skin — or a FIRST decision against the mode, which is a flip too.
    if (prev ? prev.isDark === next.isDark : next.isDark === Theme.chromeIsDark) return
    const rgb = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map(v => Math.round(v * 255)).join(",")
    const st = stats ? ` mean ${rgb(stats.mean)} brightest ${rgb(stats.brightest)} darkest ${rgb(stats.darkest)} samples ${stats.samples}` : ""
    console.log(`[AdaptiveGlass] ${s.id}: skin ${prev ? (prev.isDark ? "dark" : "light") : "(none)"} → ${next.isDark ? "dark" : "light"} (${why}, probe ${s.id}-${s.seq}, ws ${hyprlandState.focusedWorkspaceId})${st}`)
}

function apply(s: Surface, next: GlassDecision, why = "measured", stats: BackdropStats | null = s.lastStats) {
    const prev = s.decision
    logFlip(s, prev, next, why, stats)
    s.decision = next
    if (!prev || prev.isDark !== next.isDark || Math.abs((s.shownAlpha ?? 0) - next.alpha) >= 0.005)
        s.quietUntilUs = GLib.get_monotonic_time() + (TRANSITION_MS + QUIET_AFTER_CHANGE_MS) * 1000
    if (!prev || prev.isDark !== next.isDark) {
        // A flip is not animated in alpha: the surface wears a different material.
        if (s.animId !== null) { GLib.source_remove(s.animId); s.animId = null }
        s.shownAlpha = next.alpha
        applySkinClass(s)
        redrawSubtree(s.root)
        return
    }
    const from = s.shownAlpha ?? floorFor(s)
    if (Math.abs(from - next.alpha) < 0.005) return
    if (s.animId !== null) GLib.source_remove(s.animId)
    const t0 = GLib.get_monotonic_time()
    s.animId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TRANSITION_STEP_MS, () => {
        const t = Math.min(1, (GLib.get_monotonic_time() - t0) / (TRANSITION_MS * 1000))
        const eased = 1 - Math.pow(1 - t, 3)
        s.shownAlpha = from + (next.alpha - from) * eased
        redrawSubtree(s.root)
        if (t >= 1) { s.animId = null; return GLib.SOURCE_REMOVE }
        return GLib.SOURCE_CONTINUE
    })
}

/** Back to exactly the user's glass — the state of a surface nobody has measured. */
function reset(s: Surface) {
    if (s.animId !== null) { GLib.source_remove(s.animId); s.animId = null }
    const had = s.decision !== null
    s.decision = null
    s.shownAlpha = null
    applySkinClass(s)
    if (had) redrawSubtree(s.root)
}

// ── measuring ───────────────────────────────────────────────────────────────

/** Hyprland's colour settings for its blur, read once and on every config reload
 *  (`hyprctl getoption` is a synchronous spawn: never per measurement). */
let blur: HyprlandBlurParams = NIDARA_BLUR
function readBlur() {
    blur = {
        contrast: hyprlandState.getOptionFloat("decoration:blur:contrast", NIDARA_BLUR.contrast),
        brightness: hyprlandState.getOptionFloat("decoration:blur:brightness", NIDARA_BLUR.brightness),
        vibrancy: hyprlandState.getOptionFloat("decoration:blur:vibrancy", NIDARA_BLUR.vibrancy),
        vibrancyDarkness: hyprlandState.getOptionFloat("decoration:blur:vibrancy_darkness", NIDARA_BLUR.vibrancyDarkness),
        passes: Math.max(1, Math.round(hyprlandState.getOptionFloat("decoration:blur:passes", NIDARA_BLUR.passes))),
    }
}

/** What a visible surface covers on its monitor now — to keep a CLOSED panel's
 *  measurement from reading our own glass as its backdrop. */
function boundsOf(s: Surface): MonitorRect | null {
    const w = s.probe ? s.probe() : s.root
    const native = w?.get_native()
    if (!w || !native || !w.get_mapped() || s.hidden?.()) return null
    const [ok, b] = w.compute_bounds(native as unknown as Gtk.Widget)
    if (!ok) return null
    const o = s.windowOrigin?.() ?? { x: 0, y: 0 }
    const a = s.probeArea?.() ?? { x: 0, y: 0, width: b.get_width(), height: b.get_height() }
    return { x: b.get_x() + o.x + a.x, y: b.get_y() + o.y + a.y, width: a.width, height: a.height }
}

/**
 * A CLOSED panel, measured where it last opened, so it opens already wearing the right
 * glass — owner-caught 2026-09-29: a panel appeared in one skin and switched a moment
 * after, because only an open panel was measured and it opened with whatever it had
 * decided last time. The open measurement still runs once it settles and has the last
 * word (it sees the panel's real size and our real paint).
 */
async function measureClosed(s: Surface) {
    const rest = s.restsAt?.()
    if (rest) { s.lastRect = rest.rect; s.lastMonitor = rest.monitor }
    if (!s.lastRect || !s.lastMonitor) return
    const seq = ++s.seq
    const exclude: MonitorRect[] = [...(s.exclude?.() ?? [])]
    for (const other of surfaces.values()) {
        if (other === s) continue
        const r = boundsOf(other)
        if (r) exclude.push(r)
    }
    let stats: BackdropStats | null = null
    try {
        stats = await probeClosedBackdrop({ monitor: s.lastMonitor, rect: s.lastRect, blur, exclude, tag: `${s.id}-${seq}` })
    } catch (e) {
        console.warn(`[AdaptiveGlass] ${s.id}: closed probe failed: ${e}`)
    }
    // Opened meanwhile: the open measurement owns it now.
    if (seq !== s.seq || !surfaces.has(s.root) || shown(s) || !stats) return
    s.lastProbeUs = GLib.get_monotonic_time()
    s.closedAtUs = s.lastProbeUs
    s.lastStats = stats
    const next = s.skinFromBackdrop
        ? decideGlassByBackdrop(stats, floorFor(s), s.decision ?? undefined)
        : decideGlass(stats, Theme.chromeIsDark, floorFor(s), s.decision ?? undefined, s.content)
    // Nothing on screen to animate: it simply opens like this.
    if (s.animId !== null) { GLib.source_remove(s.animId); s.animId = null }
    logFlip(s, s.decision, next, "measured closed", stats)
    s.decision = next
    s.shownAlpha = next.alpha
    applySkinClass(s)
}

async function measure(s: Surface) {
    if (!shown(s)) {
        // A GROUP is measured only on screen. Its members decide together, from what is
        // behind each of them now; a closed measurement decides alone (there is no group
        // step in it) and leaves a backdrop in `lastStats` that the group then merges.
        // The island's capsule, hidden under a fullscreen window, measured that WINDOW,
        // and the bar row came back from fullscreen in its skin (2026-09-29, ws 5). A
        // group member comes back where it was, over what it had: nothing to predict.
        if (!s.group?.()) await measureClosed(s)
        return
    }
    if (s.settled && !s.settled()) { s.missed = true; return }
    // Our own tint mid-animation, or a change not yet on screen everywhere: the
    // capture and the render would describe different surfaces.
    if (s.animId !== null) { schedule(s); return }
    const quietMs = (s.quietUntilUs - GLib.get_monotonic_time()) / 1000
    if (quietMs > 0) { schedule(s, Math.ceil(quietMs)); return }
    const target = s.probe ? s.probe() : s.root
    if (!target || !target.get_mapped()) return
    // Already known: measured CLOSED since the last thing that could change the backdrop,
    // and opened where it was measured. The open measurement is the expensive one (the
    // offscreen render: 12 ms for the full-width overview, measured) and would only
    // confirm what the closed one — the same model to 2/255 — already decided.
    if (s.closedAtUs > lastEventUs && s.lastRect && sameRect(boundsOf(s), s.lastRect)) return
    const seq = ++s.seq
    let stats: BackdropStats | null = null
    try {
        stats = await probeBackdrop({
            widget: target,
            windowOrigin: s.windowOrigin?.(),
            exclude: s.exclude?.() ?? [],
            area: s.probeArea?.() ?? undefined,
            seeThrough: s.skinFromBackdrop ? blur : undefined,
            tag: `${s.id}-${seq}`,
            onRegion: (r, m) => { s.lastRect = r; s.lastMonitor = m },
        })
    } catch (e) {
        console.warn(`[AdaptiveGlass] ${s.id}: probe failed: ${e}`)
    }
    // A newer measurement started, or the surface left, while this one was out.
    if (seq !== s.seq || !surfaces.has(s.root) || !shown(s)) return
    s.lastProbeUs = GLib.get_monotonic_time()
    if (!stats) {
        // Nothing measurable YET is common right after a map (no frame painted) —
        // try again a few times, backing off; past that, the surface simply has too
        // little glass in view (an empty banner stack), and the next event will ask.
        if (s.retries < MAX_RETRIES) { s.retries++; schedule(s, DEBOUNCE_MS * (1 << s.retries)) }
        return
    }
    s.retries = 0
    s.lastStats = stats
    const group = s.group?.() ?? null
    if (!group) {
        apply(s, s.skinFromBackdrop
            ? decideGlassByBackdrop(stats, floorFor(s), s.decision ?? undefined)
            : decideGlass(stats, Theme.chromeIsDark, floorFor(s), s.decision ?? undefined, s.content))
        return
    }
    // One decision for the whole group: its skin from the mean of everything its members
    // cover, its body from the worst of every member's backdrop.
    // A member not measured yet contributes nothing, and is simply told the answer —
    // EXCEPT the one whose backdrop gives the group its skin (`skinFromBackdrop`, the
    // bar): until it has been measured, the group does not decide. Measured 2026-09-29,
    // at every shell start: the bar's first probe finds it not yet painted, the island's
    // succeeds, and the row decided from the island's capsule alone — a pinkish patch
    // that reads LIGHT — and the whole bar went light for the 1.6 s until the bar's
    // retry landed (owner-caught as "the bar goes light on workspace 3, for nothing").
    const members = [...surfaces.values()].filter(m => m.root.get_mapped() && m.group?.() === group)
    if (members.some(m => m.skinFromBackdrop && !m.lastStats)) return
    const merged = mergeBackdropStats(members.map(m => m.lastStats).filter((x): x is BackdropStats => x !== null))
    const floor = Math.max(...members.map(m => floorFor(m)))
    const next = members.some(m => m.skinFromBackdrop)
        ? decideGlassByBackdrop(merged, floor, s.decision ?? undefined)
        : decideGlass(merged, Theme.chromeIsDark, floor, s.decision ?? undefined, s.content)
    for (const m of members) apply(m, next, `group ${group} [${members.map(m => m.id).join("+")}]`, merged)
}

const pending = new Map<Surface, number>()

function schedule(s: Surface, delayMs = DEBOUNCE_MS) {
    const old = pending.get(s)
    if (old !== undefined) GLib.source_remove(old)
    pending.set(s, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        pending.delete(s)
        void measure(s)
        return GLib.SOURCE_REMOVE
    }))
}

/** When something last happened that can change what is behind a surface (µs). */
let lastEventUs = 0

/** The same place, give or take the rounding a capture region gets. */
function sameRect(a: MonitorRect | null, b: MonitorRect): boolean {
    return !!a && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2
        && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2
}

function scheduleAll(delayMs = DEBOUNCE_MS) {
    lastEventUs = GLib.get_monotonic_time()
    // Closed panels too, where they last opened (`measureClosed`).
    for (const s of surfaces.values()) if (s.root.get_mapped() || s.lastRect) schedule(s, delayMs)
}

// ── registry ────────────────────────────────────────────────────────────────

export interface GlassSurfaceHandle {
    /** Measure soon (debounced) — e.g. when the surface has just settled open. A
     *  delay for content that animates in without a revealer to say when it lands. */
    remeasure(delayMs?: number): void
    /** The surface has just come to rest (the dock's springs stopped): measure now only
     *  if something happened while it was moving. Cheap to call on every stop. */
    settle(): void
    /** Stop adapting; the surface goes back to the user's glass. */
    dispose(): void
}

export function registerGlassSurface(opts: GlassSurfaceOpts): GlassSurfaceHandle {
    const s: Surface = {
        ...opts, decision: null, shownAlpha: null, lastStats: null, lastProbeUs: 0, seq: 0, animId: null, retries: 0, quietUntilUs: 0, lastRect: null, lastMonitor: null, closedAtUs: 0, missed: false,
    }
    surfaces.set(opts.root, s)
    // A surface that is hidden keeps its last decision: the next time it opens over
    // the same backdrop it is already right, instead of opening thin and thickening
    // in front of the user. The measurement on settling corrects it if not.
    opts.root.connect("map", () => schedule(s, MAP_SETTLE_MS))
    return {
        remeasure: (delayMs = 0) => schedule(s, delayMs),
        settle: () => { if (s.missed) { s.missed = false; schedule(s) } },
        dispose: () => {
            const p = pending.get(s)
            if (p !== undefined) { GLib.source_remove(p); pending.delete(s) }
            reset(s)
            surfaces.delete(opts.root)
        },
    }
}

/** Measure every mapped surface now (after the usual settle) — `nidara-ipc
 *  glassRemeasure`, for verifying and for an agent that just changed what is behind. */
export function remeasureAllGlass(): number {
    lastEventUs = GLib.get_monotonic_time()   // asked for: nothing counts as already known
    let n = 0
    for (const s of surfaces.values()) if (s.root.get_mapped() || s.lastRect) { schedule(s, 0); n++ }
    return n
}

/** What each surface wears and why — `dumpState.glass`, for agents and for
 *  verifying this feature without a screenshot. */
export function adaptiveGlassState() {
    const round = (v: number) => Math.round(v * 1000) / 1000
    const rgb = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map(v => Math.round(v * 255))
    return [...surfaces.values()].map(s => ({
        id: s.id,
        role: roleOf(s),
        group: s.group?.() ?? null,
        mapped: s.root.get_mapped(),
        hidden: !!s.hidden?.(),
        content: s.content ?? "text",
        floor: round(floorOf(roleOf(s))),
        alpha: s.shownAlpha === null ? null : round(s.shownAlpha),
        // With a halo, `alpha` is the effective one; these are its two shares.
        ...(s.halo ? { halo: round(haloAlphaFor(s.root)), tiles: round(glassAlphaFor(s.root, roleOf(s))) } : {}),
        skin: s.decision ? (s.decision.isDark ? "dark" : "light") : null,
        flipped: s.decision ? s.decision.isDark !== Theme.chromeIsDark : false,
        skinFrom: s.skinFromBackdrop ? "backdrop" : "mode",
        backdrop: s.lastStats ? { brightest: rgb(s.lastStats.brightest), mean: rgb(s.lastStats.mean), darkest: rgb(s.lastStats.darkest), samples: s.lastStats.samples, area: s.lastStats.area } : null,
        measuredMsAgo: s.lastProbeUs ? Math.round((GLib.get_monotonic_time() - s.lastProbeUs) / 1000) : null,
    }))
}

// ── the events that can change what is behind a surface ────────────────────

let wired = false
/** Called once from app.ts, after the surfaces exist. */
export function startAdaptiveGlass(): void {
    if (wired) return
    wired = true
    readBlur()
    hyprlandState.connect("config-reloaded", readBlur)
    // Only what can change the PIXELS behind a surface: geometry, workspace,
    // fullscreen — and focus only when it lands on a floating window, which raises
    // it over the others. A plain focus change between tiled windows moves nothing,
    // and HyprlandState reports every one of them.
    let lastSig = ""
    hyprlandState.connect("changed", () => {
        const focused = hyprlandState.focusedClient as any
        let sig = `${hyprlandState.focusedWorkspaceId}|${focused?.floating ? focused.address : ""}`
        for (const c of hyprlandState.clients as any[])
            if (c) sig += `;${c.address},${c.x},${c.y},${c.width},${c.height},${c.fullscreen},${c.floating},${c.workspace?.id ?? ""}`
        if (sig === lastSig) return
        lastSig = sig
        scheduleAll()
    })
    // "changed" fires when `awww img` RETURNS, which is when the daemon STARTS its
    // transition — measured 2026-09-29: the probe right after it saw the old and the
    // new image half and half, and flipped on that.
    Wallpaper.connect("changed", () => scheduleAll(WALLPAPER_TRANSITION_MS))
    // The theme: a mode change moves `chromeIsDark`, and a slider move moves the floor.
    // Every surface that follows the mode re-decides NOW from the backdrop it last
    // measured — the backdrop does not depend on our skin, so no capture is needed.
    // Waiting for the measurement instead left each surface in the OLD skin for a second
    // after a mode switch (its stored decision read as "flipped" against the new mode),
    // and anything that asked in that second kept the wrong answer: the dock's tooltips
    // came up with black text on dark glass (2026-09-29). The measurement still follows.
    let lastMode = Theme.chromeIsDark
    Theme.connect("changed", () => {
        const modeChanged = Theme.chromeIsDark !== lastMode
        lastMode = Theme.chromeIsDark
        for (const s of surfaces.values()) {
            // The bar row reads its skin from its backdrop, not the mode: its group
            // re-decides on the measurement, as before.
            if (s.lastStats && !s.skinFromBackdrop && !s.group?.()) {
                // A fresh decision across a mode change: the old one's skin was chosen
                // against the OTHER mode, and passing it would read as a flip to keep.
                apply(s, decideGlass(s.lastStats, Theme.chromeIsDark, floorFor(s),
                    modeChanged ? undefined : s.decision ?? undefined, s.content), "theme changed")
            } else applySkinClass(s)
        }
        scheduleAll()
    })
}
