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
    swipeX = 0            // transient horizontal swipe offset (notification dismiss)

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

    // Transient horizontal offset for swipe-to-dismiss. Paint-only (a snapshot
    // translate, like the scale), so it never changes the child's allocation —
    // no per-frame reflow (which double-painted wrapped labels) and no width
    // squeeze. The gesture holds the pointer while dragging, so hit-testing
    // desync during the swipe is irrelevant; on release it returns to 0 (or the
    // banner is dismissed), ending at identity — commandment 9 stays satisfied.
    setSwipe(dx: number) {
        if (this.swipeX === dx) return
        this.swipeX = dx
        // While offset, let the card travel past its own box (and the gap to the
        // screen edge) instead of clipping at the box border. Back to HIDDEN at
        // rest so the grow/collapse unroll clips as designed.
        this.overflow = dx !== 0 ? Gtk.Overflow.VISIBLE : Gtk.Overflow.HIDDEN
        this.queue_draw()
    }

    // Cancel any running transition tick, freezing progress/opacity/swipe where
    // they are. Re-grabbing a snapping-back swipe uses this to take over the
    // ghost mid-flight.
    cancelAnim() {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
    }

    // Fling the card off-screen in the swipe direction, fading, then onDone
    // (swipe-to-dismiss past threshold). Overflow stays VISIBLE for the travel;
    // the widget is dropped in onDone, so it never has to return to rest.
    swipeOut(toX: number, onDone?: () => void) {
        this.cancelAnim()
        this.overflow = Gtk.Overflow.VISIBLE
        const fromX = this.swipeX
        const fromOp = this.opacity
        const duration = 200
        let startUs: number | null = null
        this.tickId = this.add_tick_callback((_w, frameClock) => {
            const now = frameClock.get_frame_time()
            if (startUs === null) startUs = now
            const t = Math.min(1, (now - startUs) / (duration * 1000))
            const eased = 1 - Math.pow(1 - t, 3)   // ease-out
            this.swipeX = fromX + (toX - fromX) * eased
            this.opacity = fromOp * (1 - t)
            this.queue_draw()
            if (t >= 1) {
                this.tickId = null
                onDone?.()
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    // Ease the swipe back to rest after a below-threshold release: swipeX → 0,
    // opacity back to 1. Ends exactly at identity — the ghosted NC swipe swaps
    // the live row back in at that moment, so any residue would show as a seam.
    settleSwipe(onDone?: () => void) {
        this.cancelAnim()
        const fromX = this.swipeX
        const fromOp = this.opacity
        const duration = 160
        let startUs: number | null = null
        this.tickId = this.add_tick_callback((_w, frameClock) => {
            const now = frameClock.get_frame_time()
            if (startUs === null) startUs = now
            const t = Math.min(1, (now - startUs) / (duration * 1000))
            const eased = 1 - Math.pow(1 - t, 3)   // ease-out (decelerate into place)
            this.swipeX = fromX * (1 - eased)
            this.opacity = fromOp + (1 - fromOp) * eased
            this.queue_draw()
            if (t >= 1) {
                this.tickId = null
                this.swipeX = 0
                this.overflow = Gtk.Overflow.HIDDEN
                this.opacity = 1
                onDone?.()
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    // Collapse the widget away in place: shrink (animateLayout → height too, so
    // siblings close the gap) and fade FROM THE CURRENT opacity to 0, then drop.
    // Swipe-to-dismiss for NC rows, which can't slide off (the scroller clips) —
    // unlike reveal(false), it continues from whatever opacity the drag left,
    // so there's no jump-back-to-1 flicker before the fade.
    collapseAway(onDone?: () => void) {
        this.cancelAnim()
        const fromProgress = this.progress
        const fromOpacity = this.opacity
        const duration = this.durationOut
        let startUs: number | null = null
        this.tickId = this.add_tick_callback((_w, frameClock) => {
            const now = frameClock.get_frame_time()
            if (startUs === null) startUs = now
            const t = Math.min(1, (now - startUs) / (duration * 1000))
            const eased = Math.pow(t, 3)   // ease-in (accelerate away), matches reveal-close
            this.progress = fromProgress * (1 - eased)
            this.opacity = fromOpacity * (1 - eased)
            if (this.animateLayout) this.queue_resize(); else this.queue_draw()
            if (t >= 1) {
                this.tickId = null
                this.set_visible(false)
                onDone?.()
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
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
        if (s >= 1 && this.swipeX === 0) { this.snapshot_child(this.child, snapshot); return }
        snapshot.save()
        if (this.swipeX !== 0) {
            const off = new Graphene.Point()
            off.init(this.swipeX, 0)
            snapshot.translate(off)
        }
        if (s < 1) {
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
            snapshot.translate(pivot)
            snapshot.scale(s, s)
            snapshot.translate(back)
        }
        this.snapshot_child(this.child, snapshot)
        snapshot.restore()
    }

    // Jump straight to the hidden end-state, no animation: cancel any running
    // transition and leave exactly what reveal(false) leaves behind. For when
    // an open panel must be re-anchored somewhere else (the bar expansion
    // switching pills in one click): snap hidden → swap content → reposition →
    // fresh reveal(true), so the new content never paints at the old spot.
    snapClosed() {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        this.progress = 0
        this.opacity = 0
        this.set_visible(false)
    }

    // Jump straight to the fully-revealed rest state (scale 1, opaque, visible),
    // no entry animation. For reusing the wrapper as a plain translate host —
    // the NC rows are swipeable but don't pop in one by one (the list rebuilds
    // wholesale), they just need setSwipe/swipeOut.
    showInstant() {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        this.progress = 1
        this.opacity = 1
        this.set_visible(true)
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

// Anything that can host a transient swipe: paints a horizontal offset, flings
// off, settles back, and fades. ScaleRevealer implements it.
export interface Swipeable {
    setSwipe(dx: number): void
    swipeOut(toX: number, onDone?: () => void): void
    settleSwipe(onDone?: () => void): void
    set_opacity(opacity: number): void
}

const SWIPE_MAX_DRAG = 140   // px of 1:1 travel before rubber-band resistance
// 1:1 up to the cap, then only 15% of any further travel shows — a banner/row
// never wanders across the screen, but a real flick still passes the threshold.
const swipeRubberband = (dx: number) => {
    const a = Math.abs(dx)
    return a <= SWIPE_MAX_DRAG ? dx : Math.sign(dx) * (SWIPE_MAX_DRAG + (a - SWIPE_MAX_DRAG) * 0.15)
}

// Low-level horizontal swipe DETECTOR — the gesture only, visuals are the
// caller's. Rides `target` (the widget that also carries a release-phase tap).
// Claims the sequence ONLY on clear horizontal intent (past a few px AND
// dominant over dy), so a vertical scroll underneath (the NC scroller) is never
// stolen — and once it claims, GTK cancels the release-phase tap on `target`, so
// a swipe never also opens the notification. Symmetric: either direction fires.
//
//  - onStart   once, when the swipe is recognised (claimed).
//  - onUpdate  each move while swiping, with the raw horizontal offset.
//  - onDismiss on release past threshold, with the direction (+1 right / -1 left).
//  - onCancel  on release below threshold (snapped back).
export function attachHorizontalSwipe(target: Gtk.Widget, opts: {
    onDismiss: (dir: 1 | -1) => void,
    onUpdate?: (dx: number) => void, onStart?: () => void, onCancel?: () => void,
    threshold?: number,
}) {
    const threshold = opts.threshold ?? 90
    const drag = new Gtk.GestureDrag()
    let claimed = false
    drag.connect("drag-update", (g, ox, oy) => {
        const dx = ox || 0
        if (!claimed) {
            if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(oy || 0)) return
            claimed = true
            g.set_state(Gtk.EventSequenceState.CLAIMED)
            opts.onStart?.()
        }
        opts.onUpdate?.(dx)
    })
    drag.connect("drag-end", (_g, ox) => {
        if (!claimed) return   // a tap, not a swipe — the release click handles it
        claimed = false
        const dx = ox || 0
        if (Math.abs(dx) >= threshold) { opts.onDismiss(dx >= 0 ? 1 : -1); return }
        opts.onCancel?.()
    })
    // A claimed sequence can die without a drag-end (row rebuilt mid-swipe,
    // panel closed under the finger): reset, or the stale flag makes the next
    // drag skip recognition and never claim.
    drag.connect("cancel", () => { if (claimed) { claimed = false; opts.onCancel?.() } })
    target.add_controller(drag)
}

// Swipe-to-dismiss with the slide-off-screen visual (notification banners, which
// can leave the screen). The card follows the finger (rubber-banded so it never
// wanders across the screen), then flings off past threshold. Built on the
// detector above.
//
//  - onSwipeStart fires once when the swipe is recognised (pause any auto-dismiss).
//  - onRest fires on release below threshold (snapped back — resume auto-dismiss).
//  - onDismiss fires after the off-screen fling completes (drop / n.dismiss()).
export function attachSwipeDismiss(target: Gtk.Widget, swipeable: Swipeable, opts: {
    onDismiss: () => void, onRest?: () => void, onSwipeStart?: () => void,
    threshold?: number, flingTo?: number,
}) {
    const flingTo = opts.flingTo ?? 560
    attachHorizontalSwipe(target, {
        threshold: opts.threshold,
        onStart: opts.onSwipeStart,
        onUpdate: (dx) => {
            const vis = swipeRubberband(dx)
            swipeable.set_opacity(Math.max(0.15, 1 - Math.abs(vis) / 320))
            swipeable.setSwipe(vis)
        },
        onDismiss: (dir) => swipeable.swipeOut(dir * flingTo, opts.onDismiss),
        onCancel: () => swipeable.settleSwipe(opts.onRest),
    })
}

// ── Ghosted swipe (rows clipped by a scroller) ─────────────────────────────
//
// An NC row can't slide off-screen: it lives inside a Gtk.ScrolledWindow, whose
// viewport clips any horizontal translate at the panel walls. The escape is a
// GHOST: when the swipe is recognised, the row's current render is captured as
// a static paintable (WidgetPaintable.get_current_image — the same mechanism
// GTK uses for DnD drag icons), the live row drops to opacity 0 (it keeps its
// allocation, so siblings don't jump, and it keeps the pointer grab, so the
// drag keeps tracking), and the capture is re-painted in an input-transparent
// Gtk.Fixed layered over the Bar's master overlay — ABOVE every panel, outside
// any clip. The ghost is what follows the finger and flings off-screen; the
// row itself just height-collapses once dismissed. The capture is static, but
// a card's content is inert during a 300ms swipe, so nothing is lost.

// One shared ghost layer per master overlay, created lazily on the first swipe
// and cached on the overlay itself. add_overlay order = paint order, so a
// late-added layer sits above every panel/banner. can_target keeps the
// full-window Fixed invisible to picking (the catcher must keep seeing
// outside-clicks); it never affects the layer-shell input region either —
// that region is stamped explicitly from specific widgets in Bar.
const ghostLayerFor = (overlay: Gtk.Overlay): Gtk.Fixed => {
    let layer = (overlay as any).__swipeGhostLayer as Gtk.Fixed | undefined
    if (!layer) {
        layer = new Gtk.Fixed({ can_target: false })
        overlay.add_overlay(layer)
        ;(overlay as any).__swipeGhostLayer = layer
    }
    return layer
}

// Swipe-to-dismiss for a clipped list row. `target` carries the gesture (and
// the release-phase tap the swipe cancels); `row` is the ScaleRevealer wrapper
// that gets ghosted while dragging and height-collapsed on dismiss.
//
//  - onDismiss fires after the row's collapse completes (siblings have closed
//    the gap) — dismiss the notification there.
export function attachGhostSwipeDismiss(target: Gtk.Widget, row: ScaleRevealer, opts: {
    onDismiss: () => void, threshold?: number, flingTo?: number,
}) {
    const flingTo = opts.flingTo ?? 560
    let ghost: ScaleRevealer | null = null
    let ghostLayer: Gtk.Fixed | null = null
    let base = 0   // swipe offset carried over when re-grabbing a settling ghost

    const dropGhost = () => {
        if (!ghost || !ghostLayer) return
        ghostLayer.remove(ghost)
        ghost.dismantle()
        ghost = null
    }

    // If the row vanishes mid-swipe (list rebuild on a new notification, panel
    // closed), don't leave the ghost floating on the overlay — and restore the
    // row's opacity: rows persist across NC open/close via the group cache, so
    // a row left at 0 would come back invisible.
    row.connect("unmap", () => {
        if (!ghost) return
        dropGhost()
        row.opacity = 1
    })

    attachHorizontalSwipe(target, {
        threshold: opts.threshold,
        onStart: () => {
            if (ghost) {
                // Re-grabbed while settling back: take over the existing ghost
                // where it is (a fresh capture would snapshot the invisible row).
                ghost.cancelAnim()
                base = ghost.swipeX
                return
            }
            base = 0
            const overlay = row.get_ancestor(Gtk.Overlay.$gtype) as Gtk.Overlay | null
            if (!overlay) return   // odd host — fall back to fade-only feedback below
            const [ok, bounds] = row.compute_bounds(overlay)
            if (!ok) return
            const pic = new Gtk.Picture({
                paintable: Gtk.WidgetPaintable.new(row).get_current_image(),
                can_shrink: false, halign: Gtk.Align.START, valign: Gtk.Align.START,
            })
            ghostLayer = ghostLayerFor(overlay)
            ghost = new ScaleRevealer(pic, { animateLayout: false })
            ghost.can_target = false
            ghost.showInstant()
            ghostLayer.put(ghost, bounds.get_x(), bounds.get_y())
            row.opacity = 0   // keeps its allocation + the pointer grab; the ghost is the visual now
        },
        onUpdate: (dx) => {
            if (!ghost) { row.set_opacity(Math.max(0.4, 1 - Math.abs(dx) / 300)); return }
            const vis = swipeRubberband(base + dx)
            ghost.set_opacity(Math.max(0.15, 1 - Math.abs(vis) / 320))
            ghost.setSwipe(vis)
        },
        onDismiss: (dir) => {
            if (ghost) {
                // Detach before collapsing: the collapse ends in unmap, and the
                // cleanup handler above must not kill the fling mid-flight.
                const g = ghost
                ghost = null
                g.swipeOut(dir * flingTo, () => { ghostLayer?.remove(g); g.dismantle() })
            }
            row.collapseAway(opts.onDismiss)   // gap closes while the ghost flies
        },
        onCancel: () => {
            if (!ghost) { row.set_opacity(1); return }
            ghost.settleSwipe(() => { row.set_opacity(1); dropGhost() })
        },
    })
}
