import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"

/**
 * NidaraScrolled — the shell's scroll view. One component for overlay surfaces AND
 * for windows.
 *
 * ## What was actually wrong with GTK's scrollbar
 *
 * Not that it was interactive — that it **grew**. GTK expands the overlay slider on
 * pointer *proximity*: it sets `.hovering`/`.dragging` on the node itself, which is
 * not the CSS `:hover`, so the bar reaches out toward whatever the pointer is
 * approaching. When a list's rows carry a control at their right edge (a close ✕, a
 * chevron), the bar gets there first and eats the click. CSS cannot stop it:
 * Adwaita's `scrollbar.overlay-indicator.hovering slider` beats any specificity we
 * can write in-process, its base slider rule carries `border: 4px solid transparent`
 * (8px of invisible real width) that takes over exactly when hovered, and
 * `set_can_target(false)` does nothing — proximity expansion is independent of event
 * targeting.
 *
 * So the answer is a bar of **fixed width in a reserved lane**, not a bar you cannot
 * touch. Dropping the drag was tried and was a regression; the drag was never the
 * problem.
 *
 * ## Why the bar is PAINTED, not laid out
 *
 * The first working version built the bar out of boxes and moved it with
 * `margin_top` + `height_request`. That produced three bugs at once, all from the
 * same mistake — **treating a scroll position as a layout property**:
 *
 * - **drag lagged**, because `Gtk.GestureDrag` reports offsets in the coordinate
 *   space of the widget it is attached to, and that widget was being *moved by the
 *   drag*. Every frame moved the origin the offset was measured from, so the thumb
 *   crawled behind the pointer.
 * - **flicker and ghosted content**, because changing a size request on an overlay
 *   child from an adjustment notify — which fires during allocation — queues another
 *   resize, and the view re-allocates on every scroll step.
 *
 * So: the bar is a single **stationary** `Gtk.DrawingArea` spanning the full height.
 * Scrolling only calls `queue_draw()` — no allocation, no resize, nothing to loop.
 * The gesture sits on a widget that never moves, so drag offsets are stable and
 * track the pointer exactly. The pill's colour is read from the widget's CSS
 * `color` via `get_style_context().get_color()` (same trick as
 * `common/WorkspaceSchematic.ts`), so it stays token-driven with no hardcoding —
 * which matters because nidara-kit is self-contained and cannot import the shell's
 * ThemeManager.
 *
 * Geometry never depends on the allocation either: in a ScrolledWindow the
 * adjustment's `page_size` IS the viewport height.
 */

export interface NidaraScrolledOpts {
    child: Gtk.Widget
    /** Default `Gtk.PolicyType.NEVER`. The vertical policy is always EXTERNAL. */
    hscrollPolicy?: Gtk.PolicyType
    minContentHeight?: number
    maxContentHeight?: number
    propagateNaturalHeight?: boolean
    widthRequest?: number
    /** Width of the hit lane, px. Default 12 = THUMB_HOVER + EDGE_CLEAR — enough to
     *  grab without aiming, and it must stay >= that sum or the expanded pill would
     *  have to choose between leaving the lane and touching the surface edge. */
    lane?: number
    /** Pad the child by `lane` so content never sits under the bar. Default true;
     *  pass false when the caller's own CSS already reserves the lane. */
    reserveLane?: boolean
    /** Keep the bar permanently visible instead of fading after idle. */
    alwaysVisible?: boolean
    /** Corner radius, px, of the surface whose edge this view sits flush against —
     *  the token, not a guess: `--nidara-radius-lg` 24 for a window, `-md` 16 for a
     *  card, 20 for a bar-expansion capsule. It sets how far the pill stops short of
     *  the ends so a rounded corner cannot clip it. Default 0 = square edge, or a
     *  view that does not reach the surface's own edge. */
    cornerRadius?: number
    /** Extra classes on the ScrolledWindow. */
    cssClasses?: string[]
}

export interface NidaraScrolledResult {
    /** Pack this — the Gtk.Overlay hosting the view and its bar. */
    widget: Gtk.Widget
    /** The view itself, for adjustments/policies the caller still wants to drive. */
    scrolled: Gtk.ScrolledWindow
}

// $space-1 / $space-2 — the project's 4px spacing scale, not free-hand numbers.
const THUMB_REST = 4
const THUMB_HOVER = 8
const THUMB_MIN_H = 28
const HIDE_MS = 1100
// Clearance between the pill and the surface's own edge, on all four sides. The
// vertical half keeps the pill out of a rounded corner; the horizontal half is why
// the pill is not painted flush against the trailing edge — flush, it landed ON the
// panel's border and poked through the rounded corner (reported on the clipboard
// panel: "the bar comes out at the top and on the right"). It also explains the lane:
// LANE = THUMB_HOVER + EDGE_CLEAR = 12. The hit lane keeps its full constant width —
// only the paint is inset.
const CORNER_CLEAR = 4
const EDGE_CLEAR = 4

/**
 * How much height a corner of radius `r` eats at the pill's distance from the wall.
 *
 * A rounded corner clips whatever is drawn inside its arc, and the pill runs at
 * EDGE_CLEAR from the trailing wall, so the arc reaches
 * `r - sqrt(r² - (r - EDGE_CLEAR)²)` px in from the end of the lane. 4px covers a
 * card (radius-sm/md) and is wrong for a window: `glass(floating)` is radius-lg =
 * 24px, which eats 10.7px — reported as the Settings bar being cut off at the bottom.
 * Ceiled, and never below the 4px floor, which is also the value for a square edge.
 */
const cornerClearFor = (r: number) =>
    r <= EDGE_CLEAR
        ? CORNER_CLEAR
        : Math.max(CORNER_CLEAR, Math.ceil(r - Math.sqrt(r * r - (r - EDGE_CLEAR) ** 2)))

/** Vertical pill, in the lane's own coordinates. */
function pillPath(cr: any, x: number, y: number, w: number, h: number) {
    const r = Math.min(w / 2, h / 2)
    cr.newSubPath()
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI)
    cr.closePath()
}

export function NidaraScrolled(opts: NidaraScrolledOpts): NidaraScrolledResult {
    const lane = opts.lane ?? 12

    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: opts.hscrollPolicy ?? Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.EXTERNAL,
        css_classes: opts.cssClasses ?? [],
    })
    if (opts.minContentHeight !== undefined) scrolled.min_content_height = opts.minContentHeight
    if (opts.maxContentHeight !== undefined) scrolled.max_content_height = opts.maxContentHeight
    if (opts.propagateNaturalHeight !== undefined) scrolled.propagate_natural_height = opts.propagateNaturalHeight
    if (opts.widthRequest !== undefined) scrolled.width_request = opts.widthRequest
    // BOTH sides, not just the trailing one. Padding only where the bar sits buys the
    // hit protection and loses the symmetry: a row's hover/selected fill then ends
    // `lane` px from one wall and flush against the other, which is what the sidebar
    // made obvious. Content that already has an inset wide enough to hold the lane
    // passes reserveLane: false and keeps its own (that is the preferred shape).
    if (opts.reserveLane ?? true) {
        opts.child.margin_start = (opts.child.margin_start || 0) + lane
        opts.child.margin_end = (opts.child.margin_end || 0) + lane
    }
    scrolled.set_child(opts.child)

    return {
        widget: attachScrollBar(scrolled, {
            lane,
            alwaysVisible: opts.alwaysVisible,
            cornerRadius: opts.cornerRadius,
        }),
        scrolled,
    }
}

/**
 * Give an EXISTING `Gtk.ScrolledWindow` the Nidara bar, returning the overlay to pack
 * in its place. Split out of NidaraScrolled for the views we do not construct: the
 * scroller inside a `Gtk.DropDown`'s popover is GTK's, and it was the last place in
 * the DE still showing GTK's own scrollbar (`adoptGtkScrolled` does the swap).
 */
export function attachScrollBar(
    scrolled: Gtk.ScrolledWindow,
    opts: { lane?: number, alwaysVisible?: boolean, cornerRadius?: number } = {},
): Gtk.Widget {
    const lane = opts.lane ?? 12
    const alwaysVisible = opts.alwaysVisible ?? false
    const cornerClear = cornerClearFor(opts.cornerRadius ?? 0)
    // EXTERNAL, always: the point is that GTK never creates a scrollbar widget, so
    // there is no node left to grow toward the pointer.
    scrolled.vscrollbar_policy = Gtk.PolicyType.EXTERNAL

    // ONE widget, full height, never moved and never resized by scrolling. It is the
    // hit lane and the painted thumb at once.
    const bar = new Gtk.DrawingArea({
        css_classes: ["nidara-scroll-bar"],
        halign: Gtk.Align.END,
        valign: Gtk.Align.FILL,
        width_request: Math.max(lane, THUMB_HOVER + EDGE_CLEAR),
        margin_top: cornerClear, margin_bottom: cornerClear,
        can_target: false,
        visible: false,
        opacity: alwaysVisible ? 1 : 0,
    })

    const overlay = new Gtk.Overlay()
    overlay.set_child(scrolled)
    overlay.add_overlay(bar)
    // The bar must not participate in measuring, or a view sized to its natural
    // height would reserve room for it twice.
    overlay.set_measure_overlay(bar, false)

    const vadj = scrolled.get_vadjustment()
    let hideId = 0
    let pointerInLane = false
    let dragging = false
    let dragStartValue = 0

    /** Thumb height and travel for a lane `laneH` px tall. Null when nothing scrolls. */
    const metrics = (laneH: number) => {
        const page = vadj.get_page_size()
        const span = vadj.get_upper() - vadj.get_lower()
        // Half a pixel of slack: a viewport and content differing by a rounding error
        // must not flash a bar that cannot move.
        if (page <= 0 || laneH <= 0 || span <= page + 0.5) return null
        const h = Math.max(THUMB_MIN_H, Math.round(laneH * page / span))
        return { span, page, h, travel: Math.max(1, laneH - h), range: span - page }
    }

    /** Current thumb rect, or null. Used by the draw func AND by hit-testing. */
    const thumbRect = (laneH: number) => {
        const m = metrics(laneH)
        if (!m) return null
        const progress = Math.max(0, Math.min(1, (vadj.get_value() - vadj.get_lower()) / m.range))
        return { y: progress * m.travel, h: m.h, m }
    }

    // Pointer proximity may grow what is PAINTED — never the hit lane. That
    // distinction is the whole of tech-debt #15: GTK grew the hit area, which is why
    // it could eat a neighbouring button. 4 → 8px stays inside the lane, so the
    // expanded pill cannot reach content on any surface.
    let thumbW = THUMB_REST
    let targetW = THUMB_REST
    let tickId = 0
    const animateTo = (w: number) => {
        targetW = w
        if (tickId) return
        let last = 0
        tickId = bar.add_tick_callback((_w: any, clock: any) => {
            const now = clock.get_frame_time() / 1000
            if (!last) last = now
            const dt = Math.min(50, now - last); last = now
            thumbW += (targetW - thumbW) * (1 - Math.exp(-dt / 45))   // ~120ms to settle
            if (Math.abs(targetW - thumbW) < 0.25) {
                thumbW = targetW
                tickId = 0
                bar.queue_draw()
                return false
            }
            bar.queue_draw()
            return true
        })
    }

    bar.set_draw_func((da: any, cr: any, w: number, h: number) => {
        const t = thumbRect(h)
        if (!t) return
        const col = da.get_style_context().get_color()
        const expand = (thumbW - THUMB_REST) / (THUMB_HOVER - THUMB_REST)
        // Faint full-height track, only while expanded — the macOS shape. Derived from
        // the same CSS colour, so it follows the theme without a second token.
        if (expand > 0.01) {
            cr.setSourceRGBA(col.red, col.green, col.blue, col.alpha * 0.18 * expand)
            pillPath(cr, w - EDGE_CLEAR - thumbW, 0, thumbW, h)
            cr.fill()
        }
        cr.setSourceRGBA(col.red, col.green, col.blue, col.alpha)
        // EDGE_CLEAR in from the lane's trailing edge — never flush against the
        // surface's own border. The rest of the lane is invisible hit area.
        pillPath(cr, w - EDGE_CLEAR - thumbW, t.y, thumbW, t.h)
        cr.fill()
    })

    const clearHide = () => { if (hideId) { GLib.source_remove(hideId); hideId = 0 } }

    const scheduleHide = () => {
        clearHide()
        if (alwaysVisible || pointerInLane || dragging) return
        hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_MS, () => {
            bar.opacity = 0
            // Invisible AND still clickable would swallow clicks over the lane.
            bar.can_target = false
            animateTo(THUMB_REST)
            hideId = 0
            return GLib.SOURCE_REMOVE
        })
    }

    /** Visibility is the only thing scrolling may change about the LAYOUT, and it
     *  only flips when the content itself starts or stops overflowing. */
    const syncPresence = () => {
        const scrollable = metrics(bar.get_height() || vadj.get_page_size()) !== null
        if (bar.visible !== scrollable) {
            bar.visible = scrollable
            if (!scrollable) bar.can_target = false
        }
        bar.queue_draw()
    }

    const reveal = () => {
        syncPresence()
        if (!bar.visible) return
        bar.opacity = 1
        bar.can_target = true
        scheduleHide()
    }

    // Scrolling repaints. It does not lay anything out.
    vadj.connect("notify::value", reveal)
    vadj.connect("notify::upper", syncPresence)
    vadj.connect("notify::page-size", syncPresence)

    // Motion anywhere in the view reveals the bar — otherwise a freshly opened panel
    // gives no hint that it scrolls, and the bar could not be grabbed without first
    // scrolling. Observes only; consumes nothing.
    const viewMotion = new Gtk.EventControllerMotion()
    viewMotion.connect("motion", reveal)
    scrolled.add_controller(viewMotion)

    // Sitting on the lane must not let it fade out from under the pointer.
    const laneMotion = new Gtk.EventControllerMotion()
    laneMotion.connect("enter", () => { pointerInLane = true; clearHide(); bar.opacity = 1; animateTo(THUMB_HOVER) })
    laneMotion.connect("leave", () => { pointerInLane = false; if (!dragging) animateTo(THUMB_REST); scheduleHide() })
    bar.add_controller(laneMotion)

    const setValue = (v: number) => {
        const lo = vadj.get_lower()
        const hi = vadj.get_upper() - vadj.get_page_size()
        vadj.set_value(Math.max(lo, Math.min(hi, v)))
    }

    // Drag. The gesture is on a widget that never moves, so `dy` is measured from a
    // fixed origin and the thumb tracks the pointer 1:1 (scaled from thumb travel to
    // scroll range). Pressing the empty track jumps there first, then drags from
    // that position — the same contract as every platform scrollbar.
    const drag = new Gtk.GestureDrag()
    drag.connect("drag-begin", (_g: any, _x: number, y: number) => {
        const t = thumbRect(bar.get_height())
        if (!t) return
        if (y < t.y || y > t.y + t.h) {
            setValue(vadj.get_lower() + ((y - t.h / 2) / t.m.travel) * t.m.range)
        }
        dragging = true
        dragStartValue = vadj.get_value()
        clearHide()
        bar.add_css_class("dragging")
        animateTo(THUMB_HOVER)
    })
    drag.connect("drag-update", (_g: any, _dx: number, dy: number) => {
        const m = metrics(bar.get_height())
        if (!m || !dragging) return
        setValue(dragStartValue + dy * m.range / m.travel)
    })
    drag.connect("drag-end", () => {
        dragging = false
        bar.remove_css_class("dragging")
        if (!pointerInLane) animateTo(THUMB_REST)
        bar.queue_draw()
        scheduleHide()
    })
    bar.add_controller(drag)

    // A pending timeout outliving the widget would fire on a disposed widget.
    overlay.connect("destroy", clearHide)

    syncPresence()
    return overlay
}

/**
 * Swap a GTK-internal `Gtk.ScrolledWindow` for one wearing our bar, in place.
 *
 * For views built by GTK itself, where there is no constructor of ours to call. The
 * scroller keeps every property GTK set on it (a `Gtk.DropDown` sizes its popup with
 * `max_content_height` + `propagate_natural_height` — verified intact after the swap);
 * only its parent changes, from the box to an overlay standing in the same slot.
 *
 * Returns false and leaves the widget untouched when the tree is not the expected
 * shape — a GTK version that nests things differently must degrade to GTK's own
 * scrollbar, never crash a Settings control.
 */
export function adoptGtkScrolled(
    scrolled: Gtk.ScrolledWindow,
    opts: { lane?: number, alwaysVisible?: boolean } = {},
): boolean {
    const parent = scrolled.get_parent() as Gtk.Box | null
    if (!parent || !(parent instanceof Gtk.Box)) return false
    // Read the slot BEFORE unparenting — afterwards the sibling links are gone.
    const prev = scrolled.get_prev_sibling()
    try {
        parent.remove(scrolled)
        const overlay = attachScrollBar(scrolled, opts)
        if (prev) parent.insert_child_after(overlay, prev)
        else parent.prepend(overlay)
        return true
    } catch (e) {
        console.warn("[NidaraScrolled] adoptGtkScrolled:", e)
        return false
    }
}

/**
 * The `Gtk.ScrolledWindow` inside a `Gtk.DropDown`'s popover, or null.
 * Structure (probed against GTK 4, not assumed): dropdown → GtkPopover → GtkBox →
 * [GtkBox (search entry), GtkScrolledWindow → GtkListView].
 */
function dropDownScroller(drop: Gtk.Widget): Gtk.ScrolledWindow | null {
    let child = drop.get_first_child()
    while (child) {
        if (child instanceof Gtk.Popover) {
            const box = (child as Gtk.Popover).get_child()
            let c = box?.get_first_child() ?? null
            while (c) {
                if (c instanceof Gtk.ScrolledWindow) return c as Gtk.ScrolledWindow
                c = c.get_next_sibling()
            }
        }
        child = child.get_next_sibling()
    }
    return null
}

/**
 * `Gtk.DropDown` with the shell's scroll bar in its popup list.
 *
 * Settings uses the NATIVE dropdown on purpose — its popover is a real Wayland popup,
 * so Hyprland's popup blur frosts it, which a window-overlay list cannot get (see the
 * dropdown blur tradeoff). That left GTK's scrollbar inside it: visibly a different
 * component from every other list in the DE, and carrying the same defect — it grows
 * toward the pointer, so a click near an option's trailing edge lands on the bar.
 */
export function NidaraDropDown(props: any = {}): Gtk.DropDown {
    const drop = new Gtk.DropDown(props)
    const sw = dropDownScroller(drop)
    if (sw) adoptGtkScrolled(sw)
    return drop
}
