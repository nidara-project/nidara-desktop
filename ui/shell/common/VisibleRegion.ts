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

let shim: Shim | null = null
let loading = false

function load() {
    if (shim || loading) return
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

/**
 * Declare the single rectangle this surface paints. Passing `null` clears the
 * declaration, which is also the safe state.
 */
export function setVisibleRect(
    surface: Gdk.Surface | null,
    rect: { x: number, y: number, width: number, height: number } | null,
) {
    if (!shim || !surface) return
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        shim.visible_region_clear(surface)
        return
    }
    shim.visible_region_begin(surface)
    shim.visible_region_add_rect(surface, rect.x, rect.y, rect.width, rect.height)
    shim.visible_region_commit(surface)
}
