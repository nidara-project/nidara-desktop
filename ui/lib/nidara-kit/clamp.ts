import GObject from "gi://GObject"
import { Gdk, Gtk } from "ags/gtk4"

/**
 * NidaraClamp — width-band content container with centering (pure GTK4)
 *
 * Holds the single child between `minWidth` and `maxWidth` and centers it when
 * the available space is wider. GTK4 CSS has no max-width, so this is a tiny
 * custom Gtk.LayoutManager (measure + allocate) — no libadwaita.
 *
 * Replaces the previous Adw.Clamp wrapper. Behaviour parity: layout-only, no
 * backgrounds/borders/chrome of its own.
 *
 * ⚠️ `minWidth` is not decoration — a clamp with only a ceiling has no width of
 * its own, it has a limit on someone else's. Settings ran that way and the page
 * followed the window all the way down to a 47px subtitle column, one word per
 * line (measured 2026-08-11; see WINDOW_LAYOUT in `lib/tokens.ts`). With both
 * sides equal the clamp IS the width, which is what a settings pane wants.
 *
 * Note: the ancestor NidaraSplitView uses a ZeroMinOverlay to break the
 * minimum-width chain, so this minimum does NOT propagate to the window and does
 * NOT by itself prevent resize/tiling — the window states its floor explicitly
 * via `set_size_request` (NidaraWindow). Below that floor the child keeps its
 * minimum and the SCROLL VIEW takes over, so content scrolls instead of clipping
 * — which is why the page scroller runs `hscrollPolicy: EXTERNAL`.
 */

// Custom layout manager: width is held in [minimumSize, maximumSize], child centered.
const ClampLayout = GObject.registerClass(
    class ClampLayout extends Gtk.LayoutManager {
        maximumSize = 800
        minimumSize = 0

        vfunc_get_request_mode(_widget: Gtk.Widget): Gtk.SizeRequestMode {
            return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH
        }

        vfunc_measure(
            widget: Gtk.Widget,
            orientation: Gtk.Orientation,
            forSize: number,
        ): [number, number, number, number] {
            const child = widget.get_first_child()
            if (!child || !child.get_visible()) return [0, 0, -1, -1]

            if (orientation === Gtk.Orientation.HORIZONTAL) {
                // Never request more width than the clamp allows, never less than it
                // guarantees. hexpand still fills wider space; allocate() centers
                // within it.
                const [childMin, childNat] = child.measure(orientation, -1)
                const min = this.band(childMin)
                const nat = this.band(Math.max(childNat, childMin))
                return [min, nat, -1, -1]
            }

            // Vertical (height-for-width): measure the child at the clamped width.
            const width = this.band(forSize < 0 ? this.maximumSize : forSize)
            const [childMin, childNat] = child.measure(orientation, width)
            return [childMin, childNat, -1, -1]
        }

        /** A width held inside [minimumSize, maximumSize]. The floor wins a
         *  degenerate band (min > max), so a caller cannot configure a pane that
         *  is narrower than it declared it needs. */
        band(w: number): number {
            return Math.max(this.minimumSize, Math.min(w, Math.max(this.maximumSize, this.minimumSize)))
        }

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, baseline: number): void {
            const child = widget.get_first_child()
            if (!child || !child.get_visible()) return
            const childWidth = this.band(width)
            const x = Math.max(0, Math.floor((width - childWidth) / 2))
            const alloc = new Gdk.Rectangle()
            alloc.x = x
            alloc.y = 0
            alloc.width = childWidth
            alloc.height = height
            child.size_allocate(alloc, baseline)
        }
    },
)

export function NidaraClamp(
    child: Gtk.Widget,
    maxWidth = 800,
    vexpand  = true,
    /** Width the child is guaranteed even when the space is narrower. Pass the
     *  same value as `maxWidth` for a pane of CONSTANT width. */
    minWidth = 0,
): Gtk.Widget {
    // The host is a plain C Gtk.Box (with ClampLayout replacing its BoxLayout),
    // NOT a custom GJS Gtk.Widget subclass: a GJS subclass can't unparent its
    // children on disposal — a JS vfunc_dispose is blocked when the widget is
    // finalized from GC ("still has children left" warnings + child leak).
    // GtkBox releases its children in C, which is GC-safe. Same constraint as
    // ScaleRevealer.dismantle().
    const clamp = new Gtk.Box({ hexpand: true, vexpand })
    const layout = new ClampLayout()
    layout.maximumSize = maxWidth
    layout.minimumSize = minWidth
    clamp.set_layout_manager(layout)
    clamp.append(child)
    if (vexpand) child.vexpand = true
    return clamp
}
