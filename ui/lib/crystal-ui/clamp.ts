import GObject from "gi://GObject"
import { Gdk, Gtk } from "ags/gtk4"

/**
 * CrystalClamp — max-width content container with centering (pure GTK4)
 *
 * Clamps the single child to `maxWidth` pixels and centers it when the
 * available space is wider. Below `maxWidth` the child fills the available
 * width normally. GTK4 CSS has no max-width, so this is implemented with a
 * tiny custom Gtk.LayoutManager (measure + allocate) — no libadwaita.
 *
 * Replaces the previous Adw.Clamp wrapper. Behaviour parity: layout-only, no
 * backgrounds/borders/chrome of its own.
 *
 * Note: the ancestor CrystalSplitView uses a ZeroMinOverlay to break the
 * minimum-width chain, so the clamp's content minimum does NOT propagate to
 * the window and does NOT prevent resize/tiling.
 */

// Custom layout manager: width is clamped to `maximumSize`, child centered.
const ClampLayout = GObject.registerClass(
    class ClampLayout extends Gtk.LayoutManager {
        maximumSize = 800

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
                // Never request more width than the clamp allows. hexpand still
                // fills wider space; allocate() centers within it.
                const [childMin, childNat] = child.measure(orientation, -1)
                const min = Math.min(childMin, this.maximumSize)
                const nat = Math.min(Math.max(childNat, childMin), this.maximumSize)
                return [min, nat, -1, -1]
            }

            // Vertical (height-for-width): measure the child at the clamped width.
            const width = forSize < 0 ? this.maximumSize : Math.min(forSize, this.maximumSize)
            const [childMin, childNat] = child.measure(orientation, width)
            return [childMin, childNat, -1, -1]
        }

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, baseline: number): void {
            const child = widget.get_first_child()
            if (!child || !child.get_visible()) return
            const childWidth = Math.min(width, this.maximumSize)
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

// Single-child host widget driven by ClampLayout.
const ClampBin = GObject.registerClass(
    class ClampBin extends Gtk.Widget {
        _init(params?: Partial<Gtk.Widget.ConstructorProps>) {
            super._init(params as any)
            this.set_layout_manager(new ClampLayout())
        }

        get clampLayout(): InstanceType<typeof ClampLayout> {
            return this.get_layout_manager() as InstanceType<typeof ClampLayout>
        }

        setChild(child: Gtk.Widget): void {
            child.set_parent(this)
        }

        vfunc_dispose(): void {
            // Custom Gtk.Widget subclasses must unparent children before dispose,
            // or GTK warns about finalizing a widget that still has children.
            let c = this.get_first_child()
            while (c) {
                c.unparent()
                c = this.get_first_child()
            }
            super.vfunc_dispose()
        }
    },
)

export function CrystalClamp(
    child: Gtk.Widget,
    maxWidth = 800,
    vexpand  = true,
): Gtk.Widget {
    const clamp = new ClampBin({ hexpand: true, vexpand })
    clamp.clampLayout.maximumSize = maxWidth
    clamp.setChild(child)
    if (vexpand) child.vexpand = true
    return clamp
}
