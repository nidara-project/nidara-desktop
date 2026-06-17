/**
 * Nidara — Dock axis adapter.
 *
 * Captures everything that differs between the horizontal (bottom) and vertical
 * (left/right) dock so that the shared logic can live once in DockCore.tsx.
 *
 * Each adapter OWNS its axis-specific widgets (bar/da/shim/layout) and any
 * axis-specific closure state (rendered-size guards, getGtkCenter, realizedMain,
 * the side edge). DockCore owns the orchestration and the shared mutable state
 * (smoothed bar size, slide springs, reveal flags, the anim registry) and calls
 * the adapter through this interface.
 */

import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import { DOCK_CONSTANTS, calculateDockItemMetrics } from "./DockPhysics"
import { drawSquircle } from "../../common/DrawingUtils"
import Theme from "../../core/ThemeManager"
import { dockSettings, dockSideState } from "./state"
import type { AnimState } from "./state"

// Widgets the adapter builds; DockCore assembles them into the window.
export interface AxisWidgets {
    bar: Gtk.Box
    da: Gtk.DrawingArea
    shim: Gtk.Box
    layout: Gtk.Overlay
}

// Per-icon layout values computed by DockCore (shared math) and applied by the
// adapter onto the right GTK properties for its axis. The adapter resolves its
// own widget tree from `stateWidget` (DockItem box) and `gtkRev` (the cache
// Revealer) — H and V walk the tree at different levels, by design.
export interface IconLayout {
    stateWidget: any     // state.widget (DockItem box; may be undefined)
    gtkRev: any          // widgetCache.get(id) — the Revealer
    slotMain: number     // slot extent along the main axis (width H / height V)
    tps: number          // icon pixel size
    marginLo: number     // leading margin (start H / top V)
    marginHi: number     // trailing margin (end H / bottom V)
    slide: number        // rounded reorder slide (currentSlideX)
    translate: number    // cross-axis pop-out / lift (currentTranslateY)
    scale: number
}

export interface SepLayout {
    stateWidget: any
    gtkRev: any
    slotMain: number
    curHeight: number    // currentHeight — separator line length basis
}

// Snapshot of reveal/visibility state DockCore passes to buildInputRegion.
export interface RevealState {
    isRevealed: boolean
    slideCurrent: number
    slideTarget: number
    fullscreenMode: boolean
    appGridPanelOpen: boolean
    menuOpenCount: number
}

export interface AxisAdapter {
    readonly vertical: boolean
    readonly WIN_W: number
    readonly WIN_H: number
    readonly monMain: number          // main-axis monitor extent
    readonly hideDistance: number     // auto-hide slide distance (dynamic)

    // Build & expose the axis-specific widgets. `initialSmoothedMain` seeds the
    // DA draw before the first updateSize.
    build(initialSmoothedMain: number): AxisWidgets

    // pointer → main-axis coordinate (x for H, y for V)
    mainCoord(x: number, y: number): number
    // true when the pointer is off the pill strip (drop to rest magnification)
    beyondPill(x: number, y: number): boolean

    // sizing / drawing
    updateSize(smoothedBarMain: number): void
    centerBar(totalMain: number): void

    // layer-shell
    setupAnchors(win: Gtk.Window): void
    applySlide(win: Gtk.Window, offset: number): void
    setExclusiveZone(win: Gtk.Window, zone: number): void
    // force a fresh layer-surface configure (V only; H no-op). Used once at startup
    // to make Hyprland re-honor the bar's top exclusive zone — see forceReflow impl.
    forceReflow(win: Gtk.Window): void

    // per-icon layout (tick step 2)
    // called once at the start of each layout pass, before the per-item loop, so the
    // axis can reset per-frame accumulators (V tracks the peak icon cross-extent here)
    beginLayoutPass(): void
    applyIconLayout(m: IconLayout): void
    applySeparatorLayout(m: SepLayout): void
    // pre-size a rest-state item on first render to avoid a flash (V only; H no-op)
    preSizeRestItem(gtkRev: any): void

    // magnification targets (per item)
    computeTargets(mousePos: number, state: AnimState): void

    // input region
    buildInputRegion(win: Gtk.Window, totalMain: number, st: RevealState): void

    // main-axis pixel where a centered run of `extent` px begins (used for both
    // the static item layout origin and the reorder drag-lock origin)
    mainStart(extent: number): number

    // appgrid background click: is the point inside the dock strip?
    inDockStrip(x: number, y: number): boolean

    // settings changed: reset axis widget sizes/margins for the new constants
    onSettingsResize(): void
}

// Shared flat (rest-state) target assignment — used when the pointer is away.
function setRestTargets(state: AnimState) {
    state.targetScale = 1.0
    if (state.isSeparator) {
        state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT
        state.targetMargin = 0
        state.targetHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT
    } else {
        state.targetWidth = DOCK_CONSTANTS.ICON_SIZE
        state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN
        state.targetHeight = DOCK_CONSTANTS.PILL_HEIGHT
    }
}

// ─── HORIZONTAL (bottom) ──────────────────────────────────────────────────────

export function horizontalAxis(gdkmonitor: any): AxisAdapter {
    const monMain = gdkmonitor.get_geometry().width
    const WIN_W = monMain
    const WIN_H = gdkmonitor.get_geometry().height

    let bar!: Gtk.Box
    let da!: Gtk.DrawingArea
    let shim!: Gtk.Box
    let layout!: Gtk.Overlay
    let smoothedBarMain = 0
    let lastRenderedWidth = -1
    let lastExclZone = -999

    // Cross-axis (height) tracking — mirror of the vertical adapter. The dock window is
    // full-height but only a strip at the bottom should be interactive, and that strip
    // must match the dock's CURRENT silhouette: the resting pill at rest, the pill plus
    // the magnified icon bulging UP on hover. Without this the gate (beyondPill) cut
    // magnification off at the pill's top edge, so the pointer moving onto the bulged
    // top of an icon cancelled the animation. reach() is the silhouette height measured
    // up from the screen bottom; both buildInputRegion and beyondPill use it.
    const CROSS_PAD = 6
    let peakIconCross = DOCK_CONSTANTS.ICON_SIZE
    const reach = () =>
        Math.max(
            DOCK_CONSTANTS.EXCLUSIVE_ZONE,
            dockSettings.screenGap + DOCK_CONSTANTS.PILL_PADDING + peakIconCross,
        ) + CROSS_PAD

    // Skip redundant set_input_region calls — see the matching note in verticalAxis.
    let lastRegionKey = ""

    return {
        vertical: false,
        WIN_W, WIN_H, monMain,
        get hideDistance() { return DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 4 },

        build(initialSmoothedMain: number): AxisWidgets {
            smoothedBarMain = initialSmoothedMain

            layout = new Gtk.Overlay({
                name: "cd-layout",
                css_classes: ["cd-layout"],
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.END,
                vexpand: false,
            })

            bar = new Gtk.Box({
                name: "cd-bar",
                css_classes: ["cd-bar"],
                spacing: 0,
                orientation: Gtk.Orientation.HORIZONTAL,
                halign: Gtk.Align.START,
                valign: Gtk.Align.END,
                overflow: Gtk.Overflow.HIDDEN,
                hexpand: false,
                vexpand: false,
            })

            da = new Gtk.DrawingArea({
                name: "dock-gloss-layer",
                valign: Gtk.Align.END,
                halign: Gtk.Align.START,
                height_request: DOCK_CONSTANTS.PILL_HEIGHT,
                margin_bottom: dockSettings.screenGap,
                can_focus: false,
            })
            // theme→redraw handled by DockCore (single, disconnected on destroy)
            da.set_draw_func((_, cr, w, _h) => {
                if (w <= 0 || _h <= 0) return
                const dockAlpha = Theme.dockOpacity
                const dockColor = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
                const borderCol = Theme.isDark ? { r: 1, g: 1, b: 1, a: 0.12 } : { r: 0, g: 0, b: 0, a: 0.08 }
                drawSquircle(cr, w, _h, undefined, dockAlpha, true, dockColor, undefined, false, borderCol, 3.2, 1.0, 0)
            })

            const initialMargin = Math.round((monMain - initialSmoothedMain) / 2)
            bar.margin_start = Math.max(0, initialMargin)
            da.margin_start = Math.max(0, initialMargin - DOCK_CONSTANTS.BASE_MARGIN)

            shim = new Gtk.Box({
                valign: Gtk.Align.END,
                halign: Gtk.Align.START,
                margin_bottom: dockSettings.screenGap,
                height_request: DOCK_CONSTANTS.PILL_HEIGHT,
                vexpand: false,
                overflow: Gtk.Overflow.VISIBLE,
            })

            return { bar, da, shim, layout }
        },

        mainCoord: (x: number, _y: number) => x,
        // Gate magnification by the dock's CURRENT top edge (rises with the bulge), so
        // moving the pointer onto the top of a magnified icon never cancels the animation.
        beyondPill: (_x: number, y: number) => y < WIN_H - reach(),

        updateSize(s: number) {
            smoothedBarMain = s
            if (!bar) return
            if (s === lastRenderedWidth) return
            lastRenderedWidth = s
            bar.set_size_request(s, -1)
            const targetW = s + (DOCK_CONSTANTS.BASE_MARGIN * 2)
            da.set_size_request(targetW, DOCK_CONSTANTS.PILL_HEIGHT)
            da.queue_draw()
        },

        centerBar(totalMain: number) {
            const barM = Math.round((monMain - totalMain) / 2)
            if (bar.margin_start !== barM) {
                bar.margin_start = barM
                da.margin_start = barM - DOCK_CONSTANTS.BASE_MARGIN
            }
        },

        setupAnchors(win: Gtk.Window) {
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 0)
        },
        applySlide(win: Gtk.Window, offset: number) {
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, -offset)
        },
        setExclusiveZone(win: Gtk.Window, zone: number) {
            if (zone === lastExclZone) return
            lastExclZone = zone
            Gtk4LayerShell.set_exclusive_zone(win, zone)
        },
        forceReflow(_win: Gtk.Window) { /* H anchors BOTTOM; position is bar-independent */ },

        beginLayoutPass() { peakIconCross = DOCK_CONSTANTS.ICON_SIZE },
        applyIconLayout(m: IconLayout) {
            const { slotMain, tps, marginLo, marginHi, slide, translate } = m
            if (tps > peakIconCross) peakIconCross = tps
            const revealer = (m.stateWidget || m.gtkRev) as any
            if (!revealer) return
            const itemBox = revealer.get_child ? (revealer.get_child() as Gtk.Box) : revealer
            const gtkRev = m.gtkRev
            if (revealer.width_request !== slotMain) revealer.width_request = slotMain
            if (gtkRev && gtkRev !== revealer) {
                if (gtkRev.width_request !== slotMain) gtkRev.width_request = slotMain
                if (gtkRev.height_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            }
            if (itemBox) {
                if (itemBox.width_request !== tps) itemBox.width_request = tps
                if (itemBox.height_request !== DOCK_CONSTANTS.PILL_HEIGHT) itemBox.height_request = DOCK_CONSTANTS.PILL_HEIGHT
                const htML = marginLo + slide
                const htMR = marginHi - slide
                if (itemBox.margin_start !== htML) itemBox.margin_start = htML
                if (itemBox.margin_end !== htMR) itemBox.margin_end = htMR
                itemBox.margin_bottom = Math.round(0 - (translate || 0))
            }
            const iconBox = itemBox?.get_first_child() as Gtk.Box
            if (iconBox) {
                iconBox.set_size_request(tps, -1)
                const dotZone = iconBox.get_next_sibling() as any
                if (dotZone && dotZone.height_request !== DOCK_CONSTANTS.PILL_PADDING) {
                    dotZone.height_request = DOCK_CONSTANTS.PILL_PADDING
                }
                const plateOverlay = iconBox.get_first_child() as Gtk.Overlay
                if (plateOverlay && plateOverlay.get_child) {
                    const daIcon = plateOverlay.get_child()
                    if (daIcon) {
                        daIcon.set_size_request(tps, tps)
                        ;(daIcon as any).set_content_width?.(tps)
                        ;(daIcon as any).set_content_height?.(tps)
                        const icon = (daIcon as any).get_next_sibling()
                        if (icon) icon.set_size_request(tps, tps)
                    }
                } else {
                    const icon = iconBox.get_first_child()
                    if (icon) {
                        icon.set_size_request(tps, tps)
                        ;(icon as any).set_content_width?.(tps)
                        ;(icon as any).set_content_height?.(tps)
                    }
                }
            }
        },

        applySeparatorLayout(m: SepLayout) {
            const { slotMain } = m
            const revealer = (m.stateWidget || m.gtkRev) as any
            if (!revealer) return
            const itemBox = revealer.get_child ? revealer.get_child() : revealer
            const gtkRev = m.gtkRev
            if (revealer.width_request !== slotMain) revealer.width_request = slotMain
            if (revealer.height_request !== DOCK_CONSTANTS.PILL_HEIGHT) revealer.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            if (gtkRev && gtkRev !== revealer) {
                if (gtkRev.width_request !== slotMain) gtkRev.width_request = slotMain
                if (gtkRev.height_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            }
            const line = (itemBox as Gtk.CenterBox)?.get_center_widget() as Gtk.Box
            if (line) line.set_size_request(-1, DOCK_CONSTANTS.SEPARATOR_HEIGHT)
        },

        preSizeRestItem(_gtkRev: any) { /* H relies on the tick; no pre-size needed */ },

        computeTargets(mousePos: number, state: AnimState) {
            if (mousePos === -1000) { setRestTargets(state); return }
            const metrics = calculateDockItemMetrics(mousePos, state.staticCenter, state.isSeparator)
            state.targetScale = metrics.scale
            state.targetWidth = metrics.width
            state.targetHeight = metrics.height || DOCK_CONSTANTS.PILL_HEIGHT
            state.targetMargin = metrics.margin
            state.targetTranslateY = metrics.translateY
        },

        buildInputRegion(win: Gtk.Window, totalMain: number, st: RevealState) {
            const surface = win.get_native()?.get_surface()
            if (!surface) return
            // Apply only when the region's shape changed (see verticalAxis note). This
            // runs every frame during the autohide slide, so the region itself is only
            // built when the key changes — the hot path is integer math + a compare.
            const apply = (key: string, set: () => void) => {
                if (key === lastRegionKey) return
                lastRegionKey = key
                set()
            }
            const setRect = (rect: { x: number, y: number, width: number, height: number } | null) => () => {
                const region = new Cairo.Region()
                // @ts-ignore
                if (rect) region.unionRectangle(rect)
                surface.set_input_region(region)
            }
            if (st.appGridPanelOpen) { apply("null", () => surface.set_input_region(null)); return }
            if (st.fullscreenMode && !st.appGridPanelOpen && !st.isRevealed) {
                apply("empty", setRect(null)); return
            }
            if (dockSettings.autoHide && !st.isRevealed && st.slideTarget > 0
                    && st.slideCurrent >= this.hideDistance * 0.8) {
                // Edge-reveal band anchored to the screen bottom, with its outer edge run
                // THROUGH the surface's far edge (WIN_H) so the boundary row is interior to
                // the region, not its truncated edge. Mirrors verticalAxis — a thin strip
                // sitting exactly on the off-screen clip boundary was a fragile sliver to hit.
                const BAND = 24
                const slideOff = Math.round(st.slideCurrent)
                const triggerY = Math.max(0, WIN_H - slideOff - BAND)
                const height = WIN_H - triggerY
                apply(`trig:${triggerY},${height}`, setRect({ x: 0, y: triggerY, width: monMain, height })); return
            }
            if (st.menuOpenCount > 0) { apply("null", () => surface.set_input_region(null)); return }
            // Height tracks the dock's current silhouette (pill at rest, pill+bulge on hover)
            // so the bulged top of a magnified icon stays inside the region. Pin the outer
            // edge (screen bottom) to WIN_H exactly with integers — fractional geometry
            // truncated by Cairo otherwise loses the last pixel row at the wall.
            const h = reach()
            const width = Math.round(totalMain + 500)
            const x = Math.round((monMain - width) / 2)
            const y = Math.floor(WIN_H - h)
            const height = WIN_H - y
            apply(`body:${x},${y},${width},${height}`, setRect({ x, y, width, height }))
        },

        mainStart: (extent: number) => Math.max(0, (monMain - extent) / 2),
        inDockStrip: (_x: number, y: number) => y >= WIN_H - reach(),

        onSettingsResize() {
            da.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            shim.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            da.margin_bottom = dockSettings.screenGap
            shim.margin_bottom = dockSettings.screenGap
        },
    }
}

// ─── VERTICAL (left/right) ────────────────────────────────────────────────────

export function verticalAxis(gdkmonitor: any): AxisAdapter {
    const position = dockSettings.position
    const sideEdge = position === 'left' ? Gtk4LayerShell.Edge.LEFT : Gtk4LayerShell.Edge.RIGHT
    const edgeAlign = position === 'left' ? Gtk.Align.START : Gtk.Align.END

    const monMain = gdkmonitor.get_geometry().height
    const dockMonitorWidth = gdkmonitor.get_geometry().width
    const WIN_W = dockMonitorWidth
    const BAR_HEIGHT = 40
    const WIN_H = monMain - BAR_HEIGHT

    const getGtkCenter = (rh: number) => Math.round(rh / 2)

    let bar!: Gtk.Box
    let da!: Gtk.DrawingArea
    let shim!: Gtk.Box
    let layout!: Gtk.Overlay
    let smoothedBarMain = 0
    let realizedMain = WIN_H
    let lastRenderedHeight = -1
    let lastRenderedShimTop = -1
    let lastExclZone = -999

    // Cross-axis (thickness) tracking. The dock window is full-width but only a strip
    // on the edge should be interactive — and that strip must match the dock's CURRENT
    // silhouette: the resting pill at rest, the pill + the magnified icon's bulge on
    // hover. peakIconCross is the largest icon cross-size seen this layout pass (reset
    // in beginLayoutPass, accumulated in applyIconLayout). innerEdgeCross() turns it
    // into the dock's inner edge X. Both the input region (buildInputRegion) and the
    // pointer gate (beyondPill) use it, so they can never disagree — that disagreement
    // was the bug: input region 128px swallowed window clicks while the gate cut
    // magnification off at 78px.
    const CROSS_PAD = 6
    let peakIconCross = DOCK_CONSTANTS.ICON_SIZE
    const innerEdgeCross = () =>
        Math.max(
            DOCK_CONSTANTS.EXCLUSIVE_ZONE,
            dockSettings.screenGap + DOCK_CONSTANTS.PILL_PADDING + peakIconCross,
        ) + CROSS_PAD

    // The tick calls buildInputRegion every frame; re-applying an UNCHANGED region still
    // makes the compositor re-evaluate pointer focus (a leave/enter cycle that even spams
    // phantom motion on a still cursor). Guard every apply by a key of the region's shape
    // so we only touch the surface when it actually changes.
    let lastRegionKey = ""

    return {
        vertical: true,
        WIN_W, WIN_H, monMain,
        get hideDistance() { return DOCK_CONSTANTS.EXCLUSIVE_ZONE + dockSettings.screenGap },

        build(initialSmoothedMain: number): AxisWidgets {
            smoothedBarMain = initialSmoothedMain

            layout = new Gtk.Overlay({
                name: "cd-layout",
                css_classes: ["cd-layout"],
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
                vexpand: true,
            })

            bar = new Gtk.Box({
                name: "cd-bar",
                css_classes: ["cd-bar"],
                spacing: 0,
                orientation: Gtk.Orientation.VERTICAL,
                halign: edgeAlign,
                valign: Gtk.Align.START,
                overflow: Gtk.Overflow.VISIBLE,
                hexpand: false,
                vexpand: false,
            })

            da = new Gtk.DrawingArea({
                name: "dock-gloss-layer",
                valign: Gtk.Align.FILL,
                halign: Gtk.Align.FILL,
                can_focus: false,
            })
            // theme→redraw handled by DockCore (single, disconnected on destroy)
            da.set_draw_func((_, cr, _w, _h) => {
                if (_w <= 0 || _h <= 0) return
                if (_h !== realizedMain) {
                    // The true compositor-allocated height arrived (or changed). The pill
                    // below re-centers with it for free; keep the icon shim in sync too,
                    // otherwise it stays at the seeded position until the next updateSize
                    // (e.g. opening the AppGrid) — the "dock loads too high then drops" bug.
                    realizedMain = _h
                    const shimTop = Math.max(0, Math.round(getGtkCenter(_h) - smoothedBarMain / 2))
                    if (shim && shimTop !== lastRenderedShimTop) {
                        lastRenderedShimTop = shimTop
                        shim.margin_top = shimTop
                    }
                }
                const dockAlpha = Theme.dockOpacity
                const dockColor = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
                const borderCol = Theme.isDark ? { r: 1, g: 1, b: 1, a: 0.12 } : { r: 0, g: 0, b: 0, a: 0.08 }
                const pw = DOCK_CONSTANTS.PILL_HEIGHT
                const ph = smoothedBarMain + DOCK_CONSTANTS.BASE_MARGIN * 2
                const py = Math.max(0, Math.round(getGtkCenter(_h) - ph / 2))
                const px = position === 'right'
                    ? _w - DOCK_CONSTANTS.EXCLUSIVE_ZONE
                    : dockSettings.screenGap
                cr.translate(px, py)
                drawSquircle(cr, pw, ph, undefined, dockAlpha, true, dockColor, undefined, false, borderCol, 3.2, 1.0, 0)
            })

            // Shim: positioned by margin_top (set dynamically via updateSize → getGtkCenter).
            shim = new Gtk.Box({
                valign: Gtk.Align.START,
                halign: edgeAlign,
                margin_top: 0,
                margin_start: position === 'left' ? dockSettings.screenGap : 0,
                margin_end: position === 'right' ? dockSettings.screenGap : 0,
                vexpand: false,
                overflow: Gtk.Overflow.VISIBLE,
            })

            return { bar, da, shim, layout }
        },

        mainCoord: (_x: number, y: number) => y,
        beyondPill: (x: number, _y: number) => {
            // Gate magnification by the dock's CURRENT inner edge (grows with the bulge),
            // so moving the pointer onto a magnified icon never cancels the animation.
            const cross = innerEdgeCross()
            return position === 'right' ? x < WIN_W - cross : x > cross
        },

        updateSize(s: number) {
            smoothedBarMain = s
            if (!bar) return
            const ph = DOCK_CONSTANTS.PILL_HEIGHT
            const shimTop = Math.max(0, Math.round(getGtkCenter(realizedMain) - s / 2))
            if (s === lastRenderedHeight && shimTop === lastRenderedShimTop) return
            lastRenderedHeight = s
            lastRenderedShimTop = shimTop
            bar.set_size_request(ph, s)
            shim.margin_top = shimTop
            da.queue_draw()
        },

        centerBar(_totalMain: number) { /* V centers via shim.margin_top in updateSize */ },

        setupAnchors(win: Gtk.Window) {
            Gtk4LayerShell.set_anchor(win, sideEdge, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
            if ((Gtk4LayerShell as any).set_size) {
                (Gtk4LayerShell as any).set_size(win, WIN_W, WIN_H)
            }
        },
        applySlide(win: Gtk.Window, offset: number) {
            Gtk4LayerShell.set_margin(win, sideEdge, -offset)
        },
        setExclusiveZone(win: Gtk.Window, zone: number) {
            if (zone === lastExclZone) return
            lastExclZone = zone
            Gtk4LayerShell.set_exclusive_zone(win, zone)
            dockSideState.update(position, zone)
        },
        forceReflow(win: Gtk.Window) {
            // The dock is anchored SIDE+TOP+BOTTOM with an explicit set_size(WIN_H).
            // Its vertical position is driven by the bar's TOP exclusive zone pushing
            // it down to y=BAR_HEIGHT. At startup the dock often maps BEFORE the bar
            // registers that zone, so Hyprland places it at y=0 ("loads too high") and
            // doesn't reflow until the surface re-commits. Opening the AppGrid does
            // exactly this — it toggles the layer (TOP→OVERLAY→…→TOP), which Hyprland
            // treats as real state and fully reconfigures (incl. position). A transient
            // set_size can't trigger it (final size == current → Hyprland no-ops).
            // Replicate the proven path: flip to OVERLAY, then back to TOP on a LATER
            // frame so the two changes land as SEPARATE commits (same-frame coalesces
            // to no-op). Net layer is unchanged; the round-trip forces the reposition.
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
                return GLib.SOURCE_REMOVE
            })
        },

        beginLayoutPass() { peakIconCross = DOCK_CONSTANTS.ICON_SIZE },
        applyIconLayout(m: IconLayout) {
            const { gtkRev, slotMain, tps, marginLo, marginHi, slide } = m
            if (tps > peakIconCross) peakIconCross = tps
            const itemBox = (m.stateWidget || (gtkRev && gtkRev.get_child?.())) as any
            if (!itemBox) return
            // Revealer (cache) carries the slot along the main axis (Y) and pins to the
            // screen edge; its width is natural so the item can grow toward center.
            if (gtkRev) {
                if (gtkRev.height_request !== slotMain) gtkRev.height_request = slotMain
                if (gtkRev.width_request !== -1) gtkRev.width_request = -1
                gtkRev.halign = edgeAlign
            }
            // itemBox: tps tall (main axis), centered in the slot via top/bottom margins.
            // Its width grows with the icon (pinned to the edge via halign in DockItem).
            if (itemBox.height_request !== tps) itemBox.height_request = tps
            if (itemBox.margin_top    !== marginLo + slide) itemBox.margin_top    = marginLo + slide
            if (itemBox.margin_bottom !== marginHi - slide) itemBox.margin_bottom = marginHi - slide
            const dotZone = itemBox._cdDotZone
            if (dotZone && dotZone.width_request !== DOCK_CONSTANTS.PILL_PADDING) {
                dotZone.width_request = DOCK_CONSTANTS.PILL_PADDING
            }
            const iconBox = itemBox._cdIconBox
            if (iconBox) {
                iconBox.set_size_request(tps, tps)
                const icon = iconBox.get_first_child?.()
                if (icon) {
                    icon.set_size_request(tps, tps)
                    ;(icon as any).set_content_width?.(tps)
                    ;(icon as any).set_content_height?.(tps)
                    // Flush against the dotZone (edge) so the rest gap is exactly
                    // PILL_PADDING each side (centered in the pill) and it grows toward center.
                    icon.halign = edgeAlign
                }
            }
        },

        applySeparatorLayout(m: SepLayout) {
            const { gtkRev, slotMain, curHeight } = m
            if (!gtkRev) return
            const itemBox = gtkRev.get_child ? gtkRev.get_child() : gtkRev
            if (gtkRev.height_request !== slotMain) gtkRev.height_request = slotMain
            if (gtkRev.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.width_request = DOCK_CONSTANTS.PILL_HEIGHT
            gtkRev.halign = edgeAlign
            // The container's own width must track PILL_HEIGHT too. It is set once at
            // construction; a hot icon-size change (no rebuild) would otherwise leave it
            // stale — a Revealer sizes to its child, so a stale-wider container inflates
            // gtkRev/bar and the centered line lands at the OLD PILL_HEIGHT/2, drifting
            // off the (new) icon centers until the next reload.
            if (itemBox && itemBox.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) {
                itemBox.width_request = DOCK_CONSTANTS.PILL_HEIGHT
            }
            if (itemBox && itemBox.height_request !== slotMain) itemBox.height_request = slotMain
            // Match the horizontal separator's length (its line is SEPARATOR_HEIGHT tall);
            // the vertical hairline is rotated, so that length becomes its width. Fixed —
            // not driven by currentHeight, so magnification doesn't shrink it.
            void curHeight
            const line = (itemBox as Gtk.CenterBox)?.get_center_widget() as Gtk.Box
            if (line) line.set_size_request(DOCK_CONSTANTS.SEPARATOR_HEIGHT, DOCK_CONSTANTS.SEPARATOR_LINE)
        },

        preSizeRestItem(gtkRev: any) {
            if (!gtkRev) return
            const slotH = Math.round(DOCK_CONSTANTS.ICON_SIZE + 2 * DOCK_CONSTANTS.ICON_MARGIN)
            const tps   = DOCK_CONSTANTS.ICON_SIZE
            const mT = Math.floor((slotH - tps) / 2)
            const mB = Math.ceil((slotH - tps) / 2)
            if (gtkRev.height_request !== slotH) gtkRev.height_request = slotH
            if (gtkRev.width_request !== -1) gtkRev.width_request = -1
            gtkRev.halign = edgeAlign
            const itemBox = gtkRev.get_child?.()
            if (itemBox) {
                if (itemBox.height_request !== tps) itemBox.height_request = tps
                if (itemBox.margin_top    !== mT) itemBox.margin_top    = mT
                if (itemBox.margin_bottom !== mB) itemBox.margin_bottom = mB
                const dotZone = itemBox._cdDotZone
                if (dotZone && dotZone.width_request !== DOCK_CONSTANTS.PILL_PADDING) {
                    dotZone.width_request = DOCK_CONSTANTS.PILL_PADDING
                }
                const iconBox = itemBox._cdIconBox
                if (iconBox) {
                    iconBox.set_size_request(tps, tps)
                    const icon = iconBox.get_first_child?.()
                    if (icon) {
                        icon.set_size_request(tps, tps)
                        ;(icon as any).set_content_width?.(tps)
                        ;(icon as any).set_content_height?.(tps)
                        icon.halign = edgeAlign
                    }
                }
            }
        },

        // Magnification: same cosine-bell curve as horizontal. The slot grows along the
        // main axis (Y); the icon scales up and — thanks to the mirrored DockItem layout
        // (edge-anchored item + PILL_PADDING dotZone spacer) — bulges toward screen center.
        computeTargets(mousePos: number, state: AnimState) {
            if (mousePos === -1000) { setRestTargets(state); return }
            const metrics = calculateDockItemMetrics(mousePos, state.staticCenter, state.isSeparator)
            state.targetScale = metrics.scale
            state.targetWidth = metrics.width
            state.targetHeight = metrics.height || DOCK_CONSTANTS.PILL_HEIGHT
            state.targetMargin = metrics.margin
            state.targetTranslateY = metrics.translateY
        },

        buildInputRegion(win: Gtk.Window, totalMain: number, st: RevealState) {
            const surface = win.get_native()?.get_surface()
            if (!surface) return
            // Apply only when the region's shape changed (see lastRegionKey note above).
            // Runs every frame during the autohide slide — the region is only built when
            // the key changes, so the hot path is integer math + a string compare.
            const apply = (key: string, set: () => void) => {
                if (key === lastRegionKey) return
                lastRegionKey = key
                set()
            }
            const setRect = (rect: { x: number, y: number, width: number, height: number } | null) => () => {
                const region = new Cairo.Region()
                // @ts-ignore
                if (rect) region.unionRectangle(rect)
                surface.set_input_region(region)
            }
            if (st.appGridPanelOpen) { apply("null", () => surface.set_input_region(null)); return }
            if (st.fullscreenMode && !st.appGridPanelOpen && !st.isRevealed) {
                apply("empty", setRect(null)); return
            }
            const slideOff = Math.round(st.slideCurrent)
            if (dockSettings.autoHide && !st.isRevealed && slideOff >= this.hideDistance * 0.8) {
                // Edge-reveal trigger. The window has slid fully off-screen by slideOff, so
                // its outer edge sits past the monitor wall. A thin strip whose outer edge
                // landed exactly on the monitor's clip boundary was unreliable to hit — the
                // catchable area was a sliver at the very wall. Use a comfortable band
                // anchored to the screen edge, and run its outer edge THROUGH the surface's
                // far edge (0 / WIN_W) so the boundary column is interior to the region, not
                // its truncated edge (same principle as the magnification last-pixel fix).
                const BAND = 24
                const edgeX = position === 'left' ? 0 : Math.max(0, WIN_W - slideOff - BAND)
                const width = position === 'left' ? slideOff + BAND : WIN_W - edgeX
                apply(`trig:${edgeX},${width},${realizedMain}`, setRect({ x: edgeX, y: 0, width, height: realizedMain })); return
            }
            if (st.menuOpenCount > 0) { apply("null", () => surface.set_input_region(null)); return }
            // Width tracks the dock's current silhouette (pill at rest, pill+bulge on hover).
            // CRITICAL: the strip must reach the screen edge EXACTLY. Geometry can be
            // fractional (e.g. EXCLUSIVE_ZONE = pillHeight + screenGap), and Cairo truncates
            // the rect to ints — so `x = WIN_W - pillW` (fractional) lost the last pixel
            // column, dropping the cursor out of the region at the very wall (1px in worked,
            // the wall didn't). Pin the outer edge to 0 / WIN_W with integers.
            const pillW = innerEdgeCross()
            const edgeX = position === 'left' ? 0 : Math.floor(WIN_W - pillW)
            const width = position === 'left' ? Math.ceil(pillW) : WIN_W - edgeX
            const ph = totalMain + DOCK_CONSTANTS.BASE_MARGIN * 2
            const py = Math.max(0, Math.round(getGtkCenter(realizedMain) - ph / 2))
            const PAD_MAIN = 250
            const top = Math.max(0, py - PAD_MAIN)
            const height = Math.min(realizedMain - top, ph + PAD_MAIN * 2)
            apply(`body:${edgeX},${top},${width},${Math.round(height)}`,
                setRect({ x: edgeX, y: top, width, height }))
        },

        mainStart: (extent: number) =>
            Math.max(0, Math.round(getGtkCenter(realizedMain) - extent / 2)),

        inDockStrip: (x: number, _y: number) => {
            const pillW = innerEdgeCross()
            return position === 'left' ? x < pillW : x > WIN_W - pillW
        },

        onSettingsResize() {
            if (position === 'left') shim.margin_start = dockSettings.screenGap
            else shim.margin_end = dockSettings.screenGap
            // The pill's X is computed inside the draw func from EXCLUSIVE_ZONE; nothing
            // about the da's own size/margin changes on a gap change, so it would keep the
            // stale position until the next forced redraw. Repaint it explicitly so the
            // background tracks the icons' shim margin on the same settings callback.
            da.queue_draw()
        },
    }
}
