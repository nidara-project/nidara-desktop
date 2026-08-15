import GLib from "gi://GLib"
import type Gdk from "gi://Gdk?version=4.0"

/**
 * Thin wrapper over libnidara-wl's visible-region API.
 *
 * Hyprland charges layer blur by the surface's BOX, not by the pixels that end
 * up visible, so Nidara's monitor-sized layers tax every repaint of every
 * window. Declaring what a surface actually paints recovers most of that — see
 * `references/tech-debt.md` §46.
 *
 * Loaded LAZILY and tolerated missing: the typelib is installed by install.sh
 * and the PKGBUILD, but a checkout updated without reinstalling would otherwise
 * take the whole shell down on a static `gi://NidaraWl` import. Absent shim =
 * every call is a no-op and we keep the un-optimised path.
 *
 * ⚠️ Two rules that are easy to get wrong:
 *  - Content OUTSIDE the region is NOT DRAWN (hard GL scissor). The failure mode
 *    is "the surface vanished", so pass a rect you own, and clear() the moment
 *    the surface starts painting something the rect does not describe.
 *  - The region only lands on the next real wl_surface.commit. Call this from a
 *    path that repaints; queue_draw() alone is not enough (GTK skips the frame
 *    when the render node is identical).
 */

type Shim = {
    init(): boolean
    has_visible_region(): boolean
    visible_region_begin(surface: Gdk.Surface): void
    visible_region_add_rect(surface: Gdk.Surface, x: number, y: number, w: number, h: number): void
    visible_region_commit(surface: Gdk.Surface): boolean
    visible_region_clear(surface: Gdk.Surface): void
}

const SHIM_MODULE = "gi://NidaraWl"

/**
 * Escape hatch, and the only way to A/B the optimisation without two builds.
 * `NIDARA_VISIBLE_REGION=0` keeps every surface un-optimised (full-box blur).
 *
 * It exists because of the failure mode above: if a surface ever declares a rect
 * that does not cover what it paints, the symptom is a piece of the desktop
 * MISSING — not a visual glitch someone can work around. Someone hitting that
 * needs a way to boot a working shell before they can report anything, and
 * `systemctl --user set-environment` is reachable from a TTY.
 */
const DISABLED = GLib.getenv("NIDARA_VISIBLE_REGION") === "0"

let shim: Shim | null = null
let loading = false

function load() {
    if (shim || loading) return
    if (DISABLED) {
        loading = true
        console.log("[VisibleRegion] disabled by NIDARA_VISIBLE_REGION=0 — full surfaces")
        return
    }
    loading = true
    // Specifier held in a variable ON PURPOSE. A literal makes tsc resolve the
    // module at compile time, and `@girs/` only has it once the .gir is installed
    // — so a literal turns "the shim is optional at runtime" into "the typecheck
    // fails on any machine that has not installed it yet", including CI until its
    // @girs snapshot is refreshed. See references/dev-workflow.md.
    import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init()) throw new Error("init returned false")
            if (!wl.has_visible_region()) {
                console.log("[VisibleRegion] compositor has no hyprland-surface v2 — skipping")
                return
            }
            shim = wl
            console.log("[VisibleRegion] libnidara-wl ready")
        })
        .catch(e => console.log(`[VisibleRegion] unavailable, using full surfaces: ${e}`))
}

/** Start using the shim. Safe to call more than once; also runs on import. */
export function initVisibleRegion() { load() }

load()

export type VisibleRect = { x: number, y: number, width: number, height: number }

/**
 * Declare every rectangle this surface paints. Passing `null` — or nothing with
 * area — clears the declaration, which is also the safe state.
 *
 * ⚠️ "Empty means clear" is deliberate and is NOT what the protocol says: a
 * genuinely empty `wl_region` is a surface that draws NOTHING (Hyprland cancels
 * the pass outright). Nobody wants that as the answer to "I could not measure
 * anything", so the one thing this wrapper will never produce is the region that
 * erases the caller. Say `null` to mean "I don't know" and get the whole surface.
 *
 * `wl_region_add` is additive and Hyprland iterates the clip region rather than
 * its bounding box, so N rects cost their own area, not their union's box — which
 * is what makes "the bar strip PLUS the open panel" worth declaring instead of
 * giving the whole surface back (`references/tech-debt.md` §46).
 */
export function setVisibleRects(surface: Gdk.Surface | null, rects: VisibleRect[] | null) {
    if (!shim || !surface) return
    const solid = rects?.filter(r => r.width > 0 && r.height > 0) ?? []
    if (solid.length === 0) {
        shim.visible_region_clear(surface)
        return
    }
    shim.visible_region_begin(surface)
    for (const r of solid) shim.visible_region_add_rect(surface, r.x, r.y, r.width, r.height)
    shim.visible_region_commit(surface)
}

/** Single-rect convenience over `setVisibleRects` — same contract. */
export function setVisibleRect(surface: Gdk.Surface | null, rect: VisibleRect | null) {
    setVisibleRects(surface, rect ? [rect] : null)
}

// ── The stamper: one owner for the monitor's geometry ────────────────────────
//
// 🔑 THE BUG THIS EXISTS FOR (user-caught 2026-08-10, switching to 1080p live):
// the Activity Island was cut off, the bar's capsules were cut off, and the
// AppTitle panel opened somewhere else. Reloading the UI fixed all three — a
// fresh build reads fresh geometry. The dock and the app grid were FINE.
//
// It was a clean 2x2, not a hypothesis. `Gdk.Monitor` emits `notify::geometry`
// on any mode/scale change; the dock rebuilt on it and the app grid refreshed on
// it — and those are exactly the two that survived. The bar and the island each
// captured `const monGeo = gdkmonitor.get_geometry()` at build time and never
// subscribed. The surfaces themselves resize for free (anchored on four edges);
// what goes stale are the NUMBERS they cut with — the blur region, the input
// region, and every layout budget solved from the monitor's width.
//
// 🔑 WHY A COMPONENT AND NOT TWO MORE HANDLERS. Two of four forgot BECAUSE
// subscribing was optional: `get_geometry()` is available to anyone who imports
// the monitor, so caching it is the path of least resistance and nothing ever
// says otherwise. The fix that holds is one where the surface never sees the
// monitor at all — it hands over a function that returns rectangles and is
// CALLED with the box to fit them in. If it cannot reach the geometry, it cannot
// cache it. (Prior art: GNOME Shell's LayoutManager, where chrome registers and
// the manager owns the computation, recomputing on `monitors-changed`. What is
// central is not where the number is stored — it is who does the arithmetic.)
//
// ⛔ What this deliberately does NOT own: the CONTENT of the rectangles. There is
// no duplication there to remove — the island has a `pending` state, the dock
// answers `null` while its menu is open, the app grid unmaps, the bar seals
// several rects. Each surface keeps its own producer; the stamper owns the
// geometry, the clip, the dedupe and the Wayland call.
//
// ⛔ And NOT the input region, which is a different call with the opposite safe
// state (empty = click-through, where an empty VISIBLE region would be a surface
// that draws nothing). Surfaces stamp that themselves; what they take from here
// is `geometry()`, so the numbers they cut it with are live too.
//
// ⚠️ The DOCK stays on the raw `setVisibleRect` on purpose. Its blur rect is
// fused into the same key/apply cycle as its input region (`DockAxis.ts` —
// deliberately, so the two cannot drift), it speaks buffer coordinates derived
// from `WIN_W`/`WIN_H`/`monMain` captured at build time, and `app.ts` REBUILDS
// the whole dock window on `notify::geometry` for exactly that reason. Splitting
// its two regions apart to route one of them through here would trade a real
// coupling for a cosmetic one.

export type RegionBox = { x: number, y: number, width: number, height: number }

export interface RegionStamper {
    /** The monitor's logical geometry RIGHT NOW. Read it per use; storing it is
     *  the bug this component exists to make impossible. */
    geometry(): RegionBox
    /** The surface's own box in SURFACE coordinates — the monitor's, unless the
     *  caller declared an offset (see `box` in the options). */
    box(): RegionBox
    /** Recompute and stamp. Deduped, so calling it more often than necessary is
     *  free: a stamp that changes nothing makes no Wayland call and fires no
     *  `onStamped`. That is what lets every allocation of every panel re-stamp
     *  without repainting the surface per frame. */
    stamp(): void
    /** Run `cb` after the monitor's geometry changed and before the re-stamp —
     *  for everything else the surface solved from those numbers (panel height
     *  budgets, an overflow count, a label's max width). */
    onGeometryChanged(cb: (geo: RegionBox) => void): void
}

export function createRegionStamper(opts: {
    monitor: Gdk.Monitor
    /** Resolved per stamp, never captured: a window that is hidden and presented
     *  again comes back with a DIFFERENT `Gdk.Surface`. */
    surface: () => Gdk.Surface | null
    /** Every rectangle the surface paints right now, in surface coordinates and
     *  UNCLIPPED — the stamper cuts them to `box`. `null` means "I cannot
     *  describe this", whose answer is the whole surface: content outside the
     *  region is NOT DRAWN, so guessing shows up as a missing panel. */
    rects: (box: RegionBox) => VisibleRect[] | null
    /** The surface's box when it is not the monitor's. The island is the only
     *  caller: it slides down by a top margin when something reserves space
     *  above the bar, and a rect clipped to the full monitor height would then
     *  hang off the bottom of its own buffer. */
    box?: (geo: RegionBox) => RegionBox
    /** Called only when a stamp CHANGED the declaration. The shim applies a
     *  region on the next real `wl_surface.commit`, so this is where a
     *  `queue_draw()` goes. */
    onStamped?: () => void
    /** Prefix for this stamper's log lines, e.g. "bar". */
    tag?: string
}): RegionStamper {
    const read = (): RegionBox => {
        const g = opts.monitor.get_geometry()
        return { x: g.x, y: g.y, width: g.width, height: g.height }
    }
    let geo = read()
    const subs: ((geo: RegionBox) => void)[] = []
    const boxOf = (): RegionBox =>
        opts.box ? opts.box(geo) : { x: 0, y: 0, width: geo.width, height: geo.height }

    let lastKey = ""
    // Identity, not equality: the dedupe key is only meaningful for the surface it
    // was stamped on. A window that is unmapped (fullscreen hide, a closed grid)
    // and presented again is realized onto a NEW surface with no region at all, and
    // a key carried over from the old one would suppress the stamp that gives it
    // back — a monitor-sized layer with no declaration, which is precisely the cost
    // this whole mechanism exists to avoid.
    let lastSurface: Gdk.Surface | null = null

    const stamp = () => {
        const surface = opts.surface()
        if (!surface) return
        if (surface !== lastSurface) { lastSurface = surface; lastKey = "" }
        const box = boxOf()
        const produced = opts.rects(box)
        // Intersect rather than clamp: a rect that starts left of the box has to
        // LOSE that overhang, not slide right by it. Anything that survives with
        // area is real; if nothing does, the honest answer is the whole surface —
        // an empty region means "this surface draws nothing" to the compositor.
        const solid: VisibleRect[] = []
        for (const r of produced ?? []) {
            const x0 = Math.max(box.x, Math.round(r.x))
            const y0 = Math.max(box.y, Math.round(r.y))
            const x1 = Math.min(box.x + box.width, Math.round(r.x + r.width))
            const y1 = Math.min(box.y + box.height, Math.round(r.y + r.height))
            if (x1 > x0 && y1 > y0) solid.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
        }
        const key = produced === null || solid.length === 0
            ? "none"
            : solid.map(r => `${r.x},${r.y},${r.width},${r.height}`).join("|")
        if (key === lastKey) return
        lastKey = key
        setVisibleRects(surface, solid.length ? solid : null)
        opts.onStamped?.()
    }

    try {
        opts.monitor.connect("notify::geometry", () => {
            geo = read()
            // Subscribers FIRST: they re-derive the layout numbers, and the stamp
            // that follows should describe the surface as it will be, not as it was.
            for (const cb of subs) {
                try { cb(geo) } catch (e) { console.error(`[RegionStamper:${opts.tag ?? "?"}] geometry subscriber failed:`, e) }
            }
            stamp()
        })
    } catch (e) {
        console.error(`[RegionStamper:${opts.tag ?? "?"}] monitor geometry watch failed:`, e)
    }

    return {
        geometry: () => geo,
        box: boxOf,
        stamp,
        onGeometryChanged: (cb) => { subs.push(cb) },
    }
}
