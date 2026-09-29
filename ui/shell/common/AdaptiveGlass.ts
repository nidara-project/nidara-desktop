import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"
import hyprlandState from "../core/HyprlandState"
import Wallpaper from "../core/WallpaperManager"
import { probeBackdrop, type MonitorRect } from "./BackdropProbe"
import {
    decideGlass, luminance, type GlassDecision, type BackdropStats,
} from "../../lib/nidara-kit/platform/glass-legibility"

/**
 * ADAPTIVE GLASS (#673) — each shell surface keeps its text legible over whatever is
 * behind it, by itself.
 *
 * A surface (the bar, the open panel, the island, the app grid) is REGISTERED here
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

export type GlassRole = "bar" | "overlay"

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
    /** Where the root's window starts on its monitor (see `ProbeRequest`). */
    windowOrigin?: () => { x: number; y: number }
    /** False while the surface should not be measured even though it is mapped
     *  (mid-animation). Defaults to "mapped". */
    settled?: () => boolean
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

const floorOf = (role: GlassRole) => role === "bar" ? Theme.barOpacity : Theme.overlayOpacity
const roleOf = (s: Surface): GlassRole => typeof s.role === "function" ? s.role() : s.role

/**
 * The opacity a glass painter inside `widget` should use for `role` — the user's
 * slider, or more if the surface it sits in has thickened. Outside any registered
 * surface: the slider, exactly as before.
 */
export function glassAlphaFor(widget: Gtk.Widget | null, role: GlassRole): number {
    const floor = floorOf(role)
    const s = surfaceOf(widget)
    return s?.shownAlpha != null ? Math.max(floor, s.shownAlpha) : floor
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
    if (w instanceof Gtk.DrawingArea) w.queue_draw()
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) redrawSubtree(c)
}

function applySkinClass(s: Surface) {
    const flipped = s.decision !== null && s.decision.isDark !== Theme.chromeIsDark
    s.root.remove_css_class("nidara-skin-dark")
    s.root.remove_css_class("nidara-skin-light")
    if (flipped) s.root.add_css_class(s.decision!.isDark ? "nidara-skin-dark" : "nidara-skin-light")
}

function apply(s: Surface, next: GlassDecision) {
    const prev = s.decision
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
    const from = s.shownAlpha ?? floorOf(roleOf(s))
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

async function measure(s: Surface) {
    if (!s.root.get_mapped()) return
    if (s.settled && !s.settled()) return
    // Our own tint mid-animation, or a change not yet on screen everywhere: the
    // capture and the render would describe different surfaces.
    if (s.animId !== null) { schedule(s); return }
    const quietMs = (s.quietUntilUs - GLib.get_monotonic_time()) / 1000
    if (quietMs > 0) { schedule(s, Math.ceil(quietMs)); return }
    const target = s.probe ? s.probe() : s.root
    if (!target || !target.get_mapped()) return
    const seq = ++s.seq
    let stats: BackdropStats | null = null
    try {
        stats = await probeBackdrop({
            widget: target,
            windowOrigin: s.windowOrigin?.(),
            exclude: s.exclude?.() ?? [],
            tag: `${s.id}-${seq}`,
        })
    } catch (e) {
        console.warn(`[AdaptiveGlass] ${s.id}: probe failed: ${e}`)
    }
    // A newer measurement started, or the surface left, while this one was out.
    if (seq !== s.seq || !surfaces.has(s.root) || !s.root.get_mapped()) return
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
        apply(s, decideGlass(stats, Theme.chromeIsDark, floorOf(roleOf(s)), s.decision ?? undefined))
        return
    }
    // One decision for the whole group, from the worst of every member's backdrop.
    // A member not measured yet contributes nothing, and is simply told the answer.
    const members = [...surfaces.values()].filter(m => m.root.get_mapped() && m.group?.() === group)
    const merged = mergeStats(members.map(m => m.lastStats).filter((x): x is BackdropStats => x !== null))
    const floor = Math.max(...members.map(m => floorOf(roleOf(m))))
    const next = decideGlass(merged, Theme.chromeIsDark, floor, s.decision ?? undefined)
    for (const m of members) apply(m, next)
}

/** The worst of several backdrops: the brightest of the brights, the darkest of the
 *  darks. */
function mergeStats(all: BackdropStats[]): BackdropStats {
    let brightest = all[0].brightest, darkest = all[0].darkest, samples = 0
    for (const st of all) {
        if (luminance(st.brightest) > luminance(brightest)) brightest = st.brightest
        if (luminance(st.darkest) < luminance(darkest)) darkest = st.darkest
        samples += st.samples
    }
    return { brightest, darkest, samples }
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

function scheduleAll(delayMs = DEBOUNCE_MS) {
    for (const s of surfaces.values()) if (s.root.get_mapped()) schedule(s, delayMs)
}

// ── registry ────────────────────────────────────────────────────────────────

export interface GlassSurfaceHandle {
    /** Measure soon (debounced) — e.g. when the surface has just settled open. A
     *  delay for content that animates in without a revealer to say when it lands. */
    remeasure(delayMs?: number): void
    /** Stop adapting; the surface goes back to the user's glass. */
    dispose(): void
}

export function registerGlassSurface(opts: GlassSurfaceOpts): GlassSurfaceHandle {
    const s: Surface = {
        ...opts, decision: null, shownAlpha: null, lastStats: null, lastProbeUs: 0, seq: 0, animId: null, retries: 0, quietUntilUs: 0,
    }
    surfaces.set(opts.root, s)
    // A surface that is hidden keeps its last decision: the next time it opens over
    // the same backdrop it is already right, instead of opening thin and thickening
    // in front of the user. The measurement on settling corrects it if not.
    opts.root.connect("map", () => schedule(s, MAP_SETTLE_MS))
    return {
        remeasure: (delayMs = 0) => schedule(s, delayMs),
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
    let n = 0
    for (const s of surfaces.values()) if (s.root.get_mapped()) { schedule(s, 0); n++ }
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
        floor: round(floorOf(roleOf(s))),
        alpha: s.shownAlpha === null ? null : round(s.shownAlpha),
        skin: s.decision ? (s.decision.isDark ? "dark" : "light") : null,
        flipped: s.decision ? s.decision.isDark !== Theme.chromeIsDark : false,
        backdrop: s.lastStats ? { brightest: rgb(s.lastStats.brightest), darkest: rgb(s.lastStats.darkest), samples: s.lastStats.samples } : null,
        measuredMsAgo: s.lastProbeUs ? Math.round((GLib.get_monotonic_time() - s.lastProbeUs) / 1000) : null,
    }))
}

// ── the events that can change what is behind a surface ────────────────────

let wired = false
/** Called once from app.ts, after the surfaces exist. */
export function startAdaptiveGlass(): void {
    if (wired) return
    wired = true
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
    // The theme: a mode change moves `chromeIsDark` (so a flipped surface may now be
    // wearing the user's own skin), and a slider move moves the floor.
    Theme.connect("changed", () => {
        for (const s of surfaces.values()) applySkinClass(s)
        scheduleAll()
    })
}
