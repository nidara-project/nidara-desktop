import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"

// ScaleRevealer: shows/hides its child with a grow/shrink + fade animation.
// Two modes, one engine:
//
// - animateLayout: true (default — notification banners): the *measured* height
//   follows the scale, so siblings in the same box reflow smoothly like a
//   Gtk.Revealer SLIDE_DOWN would. scaleFrom is dramatic (0.25): banners sprout
//   from under the bar's clock capsule.
// - animateLayout: false (the big overlays: CC, NC, Prism, system menu,
//   overview, app grid, bar expansion panel): behaves like a Gtk.Bin — measure
//   and allocation pass through 1:1 so external halign/margins/height_request
//   on the wrapper work exactly as they did on the child, and each frame only
//   repaints (queue_draw, no re-layout). scaleFrom is subtle (~0.97)
//   and the scaling is paint-only.
//
// The scaling is a *snapshot-time* transform (vfunc_snapshot), NOT a CSS
// transform. Commandment 9 ("no transform:scale on clickables") bans CSS
// transforms because they permanently desync visuals from GTK hit-testing;
// here the transform only exists during the transition and ends at identity,
// so the widget at rest hit-tests normally.
//
// Easing is asymmetric on purpose: ease-OUT opening (decelerate into place),
// ease-IN closing (accelerate away). A decelerate curve on the way out leaves
// a long low-opacity tail where only high-contrast content (icons, 1px Cairo
// borders) stays perceptible — that tail is what made the old CSS fade look
// non-uniform.
export type ScalePivot = "top-right" | "top-left" | "top-center" | "center"

// Shared preset for the big overlay panels (CC, NC, Prism, system menu,
// overview, app grid, bar expansion): subtle pop, fast accelerating
// exit, no layout animation. Pivot is per-surface (toward its visual anchor).
export const OVERLAY_POP = {
    scaleFrom: 0.97, durationIn: 220, durationOut: 150, animateLayout: false,
} as const

// Declaration merging: the ambient `ags/gtk4` typing exposes Gtk as `any` in
// value position (gi.d.ts) but as the real @girs namespace in type position
// (types.d.ts), so tsc can't see that this class extends Gtk.Widget. Merging
// the interface gives instances the full Widget surface for type-checking.
export interface ScaleRevealer extends Gtk.Widget {}
export class ScaleRevealer extends Gtk.Widget {
    static {
        GObject.registerClass({ GTypeName: "ScaleRevealer" }, this)
    }

    // Internal state — not part of the API (TS `private` breaks the interface
    // merge above: privates make the type nominally incomparable to Widget).
    child: Gtk.Widget
    durationIn: number
    durationOut: number
    scaleFrom: number
    pivot: ScalePivot
    animateLayout: boolean
    progress = 0          // 0 = hidden, 1 = fully revealed
    tickId: number | null = null

    constructor(child: Gtk.Widget, opts?: {
        duration?: number, durationIn?: number, durationOut?: number,
        scaleFrom?: number, pivot?: ScalePivot, animateLayout?: boolean,
    }) {
        super({ overflow: Gtk.Overflow.HIDDEN })
        this.durationIn = opts?.durationIn ?? opts?.duration ?? 300
        this.durationOut = opts?.durationOut ?? opts?.duration ?? 300
        this.scaleFrom = opts?.scaleFrom ?? 0.25
        this.pivot = opts?.pivot ?? "top-right"
        this.animateLayout = opts?.animateLayout ?? true
        this.child = child
        this.child.set_parent(this)
        this.opacity = 0
    }

    currentScale(): number {
        return this.scaleFrom + (1 - this.scaleFrom) * this.progress
    }

    // Animate towards open (1) or closed (0). `onDone` fires when the
    // transition finishes; on close the widget is hidden first, so an
    // input-region refresh in `onDone` already sees it gone.
    reveal(open: boolean, onDone?: () => void) {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        if (open) this.set_visible(true)
        const from = this.progress
        const target = open ? 1 : 0
        if (from === target) {
            if (!open) this.set_visible(false)
            onDone?.()
            return
        }
        const duration = open ? this.durationIn : this.durationOut
        let startUs: number | null = null
        this.tickId = this.add_tick_callback((_w, frameClock) => {
            const now = frameClock.get_frame_time()
            if (startUs === null) startUs = now
            const t = Math.min(1, (now - startUs) / (duration * 1000))
            const eased = open ? 1 - Math.pow(1 - t, 3)   // ease-out cubic
                              : Math.pow(t, 3)            // ease-in cubic
            this.progress = from + (target - from) * eased
            this.opacity = this.progress
            if (this.animateLayout) this.queue_resize(); else this.queue_draw()
            if (t >= 1) {
                this.tickId = null
                if (!open) this.set_visible(false)
                onDone?.()
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    vfunc_get_request_mode(): Gtk.SizeRequestMode {
        return this.child.get_request_mode()
    }

    // animateLayout: the layout height follows the animated scale so stacked
    // siblings reflow. Otherwise pure pass-through (Gtk.Bin semantics).
    vfunc_measure(orientation: Gtk.Orientation, for_size: number): [number, number, number, number] {
        const [min, nat] = this.child.measure(orientation, for_size)
        if (!this.animateLayout || orientation === Gtk.Orientation.HORIZONTAL) return [min, nat, -1, -1]
        const s = this.currentScale()
        const sMin = Math.floor(min * s)
        const sNat = Math.max(sMin, Math.floor(nat * s))
        return [sMin, sNat, -1, -1]
    }

    // animateLayout gives the child its full natural height (the shrunken look
    // comes from the painted scale, not from squeezing the child's layout);
    // pass-through mode fills like a Gtk.Bin.
    vfunc_size_allocate(width: number, height: number, baseline: number) {
        if (!this.animateLayout) { this.child.allocate(width, height, baseline, null); return }
        const [, nat] = this.child.measure(Gtk.Orientation.VERTICAL, width)
        this.child.allocate(width, nat, baseline, null)
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot) {
        const s = this.currentScale()
        if (s >= 1) { this.snapshot_child(this.child, snapshot); return }
        const w = this.get_width()
        const h = this.get_height()
        const px = this.pivot === "top-left" ? 0
                 : this.pivot === "top-right" ? w
                 : w / 2                                     // top-center | center
        const py = this.pivot === "center" ? h / 2 : 0
        const pivot = new Graphene.Point()
        pivot.init(px, py)
        const back = new Graphene.Point()
        back.init(-px, -py)
        snapshot.save()
        snapshot.translate(pivot)
        snapshot.scale(s, s)
        snapshot.translate(back)
        this.snapshot_child(this.child, snapshot)
        snapshot.restore()
    }

    // Explicit teardown — call right after removing this widget from its parent.
    // Deliberately NOT a vfunc_dispose override: GJS blocks JS vfuncs that run
    // during garbage collection, so a dispose override never fires when the
    // widget is finalized from GC and the child would leak ("still has
    // children left" warnings).
    dismantle() {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        this.child?.unparent()
    }
}
