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
