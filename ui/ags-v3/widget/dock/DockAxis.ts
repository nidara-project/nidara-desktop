/**
 * Crystal Shell — Dock axis adapter.
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
import { drawSquircle } from "../common/DrawingUtils"
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
            Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
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
        beyondPill: (_x: number, y: number) => y < WIN_H - DOCK_CONSTANTS.PILL_HEIGHT,

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

        applyIconLayout(m: IconLayout) {
            const { slotMain, tps, marginLo, marginHi, slide, translate } = m
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
            if (st.appGridPanelOpen) { surface.set_input_region(null); return }
            const region = new Cairo.Region()
            if (st.fullscreenMode && !st.appGridPanelOpen && !st.isRevealed) {
                surface.set_input_region(region); return
            }
            if (dockSettings.autoHide && !st.isRevealed && st.slideTarget > 0
                    && st.slideCurrent >= this.hideDistance * 0.8) {
                const triggerY = WIN_H - Math.round(this.hideDistance) - 4
                // @ts-ignore
                region.unionRectangle({ x: 0, y: triggerY, width: monMain, height: 4 })
                surface.set_input_region(region); return
            }
            if (st.menuOpenCount > 0) { surface.set_input_region(null); return }
            const width = totalMain + 500
            const x = (monMain - width) / 2
            const y = WIN_H - DOCK_CONSTANTS.PILL_HEIGHT
            // @ts-ignore
            region.unionRectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: DOCK_CONSTANTS.PILL_HEIGHT })
            surface.set_input_region(region)
        },

        mainStart: (extent: number) => Math.max(0, (monMain - extent) / 2),
        inDockStrip: (_x: number, y: number) => y >= WIN_H - DOCK_CONSTANTS.PILL_HEIGHT * 1.5,

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
            Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
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
            const xLimit = position === 'right'
                ? WIN_W - DOCK_CONSTANTS.EXCLUSIVE_ZONE
                : DOCK_CONSTANTS.EXCLUSIVE_ZONE
            return position === 'right' ? x < xLimit : x > xLimit
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

        applyIconLayout(m: IconLayout) {
            const { gtkRev, slotMain, tps, marginLo, marginHi, slide } = m
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
            if (st.appGridPanelOpen) { surface.set_input_region(null); return }
            const region = new Cairo.Region()
            if (st.fullscreenMode && !st.appGridPanelOpen && !st.isRevealed) {
                surface.set_input_region(region); return
            }
            const slideOff = Math.round(st.slideCurrent)
            if (dockSettings.autoHide && !st.isRevealed && slideOff >= this.hideDistance * 0.8) {
                const TRIGGER_W = 4
                const edgeX = position === 'left' ? slideOff : WIN_W - TRIGGER_W - slideOff
                // @ts-ignore
                region.unionRectangle({ x: Math.max(0, edgeX), y: 0, width: TRIGGER_W, height: realizedMain })
                surface.set_input_region(region); return
            }
            if (st.menuOpenCount > 0) { surface.set_input_region(null); return }
            const ph = totalMain + DOCK_CONSTANTS.BASE_MARGIN * 2
            const py = Math.max(0, Math.round(getGtkCenter(realizedMain) - ph / 2))
            const pillW = DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 50 // buffer for tooltips
            const edgeX = position === 'left' ? 0 : WIN_W - pillW
            // @ts-ignore
            region.unionRectangle({ x: edgeX, y: Math.max(0, py - 50), width: pillW, height: ph + 100 })
            surface.set_input_region(region)
        },

        mainStart: (extent: number) =>
            Math.max(0, Math.round(getGtkCenter(realizedMain) - extent / 2)),

        inDockStrip: (x: number, _y: number) => {
            const pillW = DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 20
            return position === 'left' ? x < pillW : x > WIN_W - pillW
        },

        onSettingsResize() {
            if (position === 'left') shim.margin_start = dockSettings.screenGap
            else shim.margin_end = dockSettings.screenGap
        },
    }
}
