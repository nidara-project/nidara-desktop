import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import { DOCK_CONSTANTS, syncConstants, springStep, slideSpringStep } from "./DockPhysics"
import type { SpringChannel } from "./DockPhysics"
import appService from "../../core/AppService"
import { DockItem, Separator, dismissActiveDockMenu } from "./DockItem"
import { drawSquircle } from "../common/DrawingUtils"
import {
    hypr, dragBus, pointerBus, savePinned, pinnedState, dockSettings, onDockSettingsChanged,
    menuState, onMenuCountChanged, dockSideState, onPinnedChanged
} from "./state"
import status from "../../core/Status"
import hs from "../../core/HyprlandState"
import Theme from "../../core/ThemeManager"
import { t } from "../../core/i18n"
import shellActions from "../../core/ShellActions"
import AppGridPanel from "../app-grid/AppGrid"

export default function DockVertical(gdkmonitor: any) {
    const sideEdge = dockSettings.position === 'left' ? Gtk4LayerShell.Edge.LEFT : Gtk4LayerShell.Edge.RIGHT

    dockSideState.update(dockSettings.position, 0)

    const norm = (s: string) => (s || "").toLowerCase().replace(".desktop", "")

    const appMatch = (k: string, lid: string) =>
        k === lid || (
            !k.startsWith("steam_app_") && !lid.startsWith("steam_app_") &&
            (k.includes(lid) || lid.includes(k))
        )

    const calculateStableHeight = (effectivePinned: string[]) => {
        const groupedClients: { [key: string]: any } = {}
        hypr.clients.forEach(c => {
            if (!c.class) return
            if (c.class.toLowerCase().includes("ags")) return
            let key = c.class.toLowerCase()
            if (["org.gnome.nautilus", "nautilus", "thunar", "dolphin", "pcmanfm", "nemo", "nemo-desktop"].includes(key))
                key = "home-shortcut"
            groupedClients[key] = true
        })
        const runningUnpinnedCount = Object.keys(groupedClients).filter(c =>
            c !== "home-shortcut" && c !== "launcher" && c !== "trash" && c !== "special:trash" &&
            !effectivePinned.some(p => norm(p) === c)
        ).length
        const apps = 3 + effectivePinned.length + runningUnpinnedCount
        const separators = 1 + (runningUnpinnedCount > 0 ? 1 : 0)
        return (apps * DOCK_CONSTANTS.APP_SLOT) + (separators * DOCK_CONSTANTS.SEPARATOR_SLOT)
    }

    const initialPinned = [...pinnedState.list]
    let totalStaticHeight = calculateStableHeight(initialPinned)
    const widgetCache = new Map<string, Gtk.Widget>()
    let lastIconTheme = Theme.iconTheme
    let firstRender = true
    let orderedIds: string[] = []
    let smoothedBarHeight = totalStaticHeight
    let currentTotalItems = 0

    const dockMonitorWidth = gdkmonitor.get_geometry().width
    const dockMonitorHeight = gdkmonitor.get_geometry().height
    const WIN_W = dockMonitorWidth
    // Bar exclusive zone height. Matches Gtk4LayerShell.set_exclusive_zone(barWin, 40) in Bar.tsx.
    const BAR_HEIGHT = 40
    // WIN_H: window height = usable area below bar. With TOP+BOTTOM+SIDE anchors and
    // explicit set_size(WIN_W, WIN_H), the compositor gives exactly this height —
    // regardless of whether it's a fresh load or a position switch.
    const WIN_H = dockMonitorHeight - BAR_HEIGHT

    // realizedH tracks the GTK-allocated height; seeded to WIN_H (same as what BOTTOM anchor gives).
    let realizedH = WIN_H

    // Center within the GTK window = half the window height. Correct because the window always
    // starts at y=BAR_HEIGHT (BOTTOM anchor positions it there), so screen center = BAR_HEIGHT + WIN_H/2.
    const getGtkCenter = (rh: number) => Math.round(rh / 2)

    // Pill slide for auto-hide — DA drawing slides; bar opacity fades
    let PILL_SLIDE_DIST = DOCK_CONSTANTS.EXCLUSIVE_ZONE + dockSettings.screenGap
    let isRevealed    = !dockSettings.autoHide
    let slideTarget   = dockSettings.autoHide ? PILL_SLIDE_DIST : 0
    let slideCurrent  = slideTarget
    let slideVelocity = 0
    const SLIDE_STIFFNESS = 500
    const SLIDE_DAMPING   = 52

    let dndActive    = false
    let isSettlingIn = dockSettings.autoHide

    const layout = new Gtk.Overlay({
        name: "cd-layout",
        css_classes: ["cd-layout"],
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        vexpand: true,
    })

    let previewIdx = -1
    let lastDraggingId = ""
    let lockedAxisStart = 0   // Y-start of draggable region (for reorder)
    let lockedStaticHeight = 0
    let isDndEnding = false
    let cursorInDock = false

    const unpinnedOpenOrder = new Map<string, number>()
    let unpinnedSeq = 0

    // Same getLaunch fix as DockHorizontal
    const getLaunch = (lid: string) => {
        return () => {
            const info = appService.getAppInfo(lid)
            let command: string
            if (info) {
                command = (info.get_commandline() || lid).replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
            } else {
                command = `gtk-launch ${GLib.shell_quote(lid)}`
            }
            execAsync(["uwsm", "app", "--", "sh", "-c", `cd "$HOME" && ${command}`]).catch(print)
        }
    }

    const onPin = (sourceId: string) => {
        const nid = norm(sourceId)
        pinnedState.list = pinnedState.list.filter(p => norm(p) !== nid)
        pinnedState.list.unshift(sourceId)
        savePinned(); update()
    }
    const onUnpin = (sourceId: string) => {
        const nid = norm(sourceId)
        pinnedState.list = pinnedState.list.filter(p => norm(p) !== nid)
        savePinned(); update()
    }
    const onReorder = (sourceId: string) => {
        const draggingId = dragBus.draggingId || sourceId
        const nsid = norm(draggingId)
        if (!nsid || nsid === "void") return

        let finalIdx = previewIdx
        if (finalIdx === -1) {
            const relY = lastMouseY - lockedAxisStart
            finalIdx = Math.floor(relY / DOCK_CONSTANTS.APP_SLOT)
        }

        const wasPinned = pinnedState.list.some(p => norm(p) === nsid)
        const pinnedCount = pinnedState.list.filter(p => norm(p) !== nsid).length
        const pinnedBoundary = 2 + pinnedCount

        if (finalIdx === currentTotalItems - 1) { onUnpin(draggingId); return }
        if (finalIdx === 1) { onPin(draggingId); return }

        if (finalIdx <= pinnedBoundary) {
            pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
            let insertIdx = finalIdx - 2
            if (insertIdx < 0) insertIdx = 0
            if (insertIdx > pinnedState.list.length) insertIdx = pinnedState.list.length
            pinnedState.list.splice(insertIdx, 0, draggingId)
            savePinned()
        } else {
            if (wasPinned) {
                pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
                savePinned()
            }
            const sortedUnpinned = [...unpinnedOpenOrder.entries()]
                .sort((a, b) => a[1] - b[1]).map(([k]) => k).filter(k => k !== nsid)
            let toIdx = Math.max(0, Math.min(finalIdx - (pinnedBoundary + 1), sortedUnpinned.length))
            sortedUnpinned.splice(toIdx, 0, nsid)
            sortedUnpinned.forEach((k, i) => unpinnedOpenOrder.set(k, i))
            unpinnedSeq = sortedUnpinned.length
        }

        previewIdx = -1
        lastDraggingId = ""
        isDndEnding = true
        update()
        GLib.timeout_add(GLib.PRIORITY_HIGH, 600, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    }

    const win = new Gtk.Window({
        name: "crystal-dock",
        css_classes: ["crystal-dock-window", "fc-ignore"],
        application: app,
        focusable: false,
        can_focus: false,
        can_target: true,
        resizable: false,
        default_height: WIN_H,
    })
    ;(win as any).gdkmonitor = gdkmonitor

    const windowOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
    windowOverlay.set_child(layout)
    win.set_child(windowOverlay)

    const edgeAlign = dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END

    const bar = new Gtk.Box({
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

    const barDismissClick = new Gtk.GestureClick({ button: 0 })
    barDismissClick.connect("pressed", () => { dismissActiveDockMenu() })
    bar.add_controller(barDismissClick)

    // Full-window drawing area — pill drawn at computed position with slide offset
    const da = new Gtk.DrawingArea({
        name: "dock-gloss-layer",
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL,
        can_focus: false,
    })
    Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })

    da.set_draw_func((_, cr, _w, _h) => {
        if (_w <= 0 || _h <= 0) return
        if (_h !== realizedH) realizedH = _h
        const dockAlpha = Theme.dockOpacity
        const dockColor = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        const borderCol = Theme.isDark ? { r: 1, g: 1, b: 1, a: 0.12 } : { r: 0, g: 0, b: 0, a: 0.08 }
        const pw = DOCK_CONSTANTS.PILL_HEIGHT
        const ph = smoothedBarHeight + DOCK_CONSTANTS.BASE_MARGIN * 2

        const py = Math.max(0, Math.round(getGtkCenter(_h) - ph / 2))

        // Horizontal position: fixed offset from edge. Auto-hide slides the whole window via margin.
        const px = dockSettings.position === 'right'
            ? _w - DOCK_CONSTANTS.EXCLUSIVE_ZONE
            : dockSettings.screenGap

        cr.translate(px, py)
        drawSquircle(cr, pw, ph, undefined, dockAlpha, true, dockColor, undefined, false, borderCol, 3.2, 1.0, 0)
    })

    let lastRenderedHeight = -1
    let lastRenderedPillH  = -1
    let lastRenderedShimTop = -1
    const updateSize = () => {
        if (!bar || !win) return
        const ph = DOCK_CONSTANTS.PILL_HEIGHT
        const shimTop = Math.max(0, Math.round(getGtkCenter(realizedH) - smoothedBarHeight / 2))
        if (smoothedBarHeight === lastRenderedHeight && ph === lastRenderedPillH && shimTop === lastRenderedShimTop) return
        lastRenderedHeight  = smoothedBarHeight
        lastRenderedPillH   = ph
        lastRenderedShimTop = shimTop
        bar.set_size_request(ph, smoothedBarHeight)
        shim.margin_top = shimTop
        if (da) da.queue_draw()
    }

    // Shim: positioned by margin_top (set dynamically via updateSize → getGtkCenter).
    // valign=START + vexpand=false so GTK doesn't stretch it; overflow=VISIBLE for icon bounds.
    const shimMarginStart = dockSettings.position === 'left'  ? dockSettings.screenGap : 0
    const shimMarginEnd   = dockSettings.position === 'right' ? dockSettings.screenGap : 0
    const shim = new Gtk.Box({
        valign: Gtk.Align.START,
        halign: edgeAlign,
        margin_top:   0,
        margin_start: shimMarginStart,
        margin_end:   shimMarginEnd,
        vexpand: false,
        overflow: Gtk.Overflow.VISIBLE,
    })
    shim.append(bar)

    layout.set_child(da)
    layout.add_overlay(shim)

    const animRegistry = new Map<string, import("./state").AnimState>()
    let tickId: number | null = null

    const setRevealed = (reveal: boolean) => {
        if (isRevealed === reveal) return
        if (!reveal && dndActive) return
        isRevealed = reveal
        slideTarget = reveal ? 0 : PILL_SLIDE_DIST
        if (layerShellReady) {
            const zone = reveal ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0
            Gtk4LayerShell.set_exclusive_zone(win, zone)
            dockSideState.update(dockSettings.position, zone)
        }
        runUnifiedTick(true)
    }

    const runUnifiedTick = (seedFrame = false) => {
        if (tickId !== null) return
        tickId = bar.add_tick_callback((_, _clock) => {
            if (menuState.openCount > 0) return true
            if (orderedIds.length === 0) { tickId = null; return false }

            const dt = 1 / 60
            let active = false

            // Step 1: Advance per-icon springs
            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                const scaleChannel: SpringChannel = { target: state.targetScale, current: state.currentScale, velocity: state.velocityScale }
                const widthChannel: SpringChannel = { target: state.targetWidth, current: state.currentWidth, velocity: state.velocityWidth }
                const marginChannel: SpringChannel = { target: state.targetMargin, current: state.currentMargin, velocity: state.velocityMargin }

                const a1 = springStep(scaleChannel, dt)
                const a2 = springStep(widthChannel, dt)
                const a3 = springStep(marginChannel, dt)

                state.currentScale = scaleChannel.current; state.velocityScale = scaleChannel.velocity
                state.currentWidth = widthChannel.current; state.velocityWidth = widthChannel.velocity
                state.currentMargin = marginChannel.current; state.velocityMargin = marginChannel.velocity

                let a4 = false
                if (state.currentSlideX !== 0 || state.targetSlideX !== 0) {
                    const slideXCh: SpringChannel = { target: state.targetSlideX, current: state.currentSlideX, velocity: state.velocitySlideX }
                    a4 = slideSpringStep(slideXCh, dt)
                    state.currentSlideX = slideXCh.current; state.velocitySlideX = slideXCh.velocity
                }

                let a5 = false
                if (state.currentHeight !== state.targetHeight) {
                    const heightCh: SpringChannel = { target: state.targetHeight, current: state.currentHeight, velocity: state.velocityHeight }
                    a5 = springStep(heightCh, dt)
                    state.currentHeight = heightCh.current; state.velocityHeight = heightCh.velocity
                }

                if (a1 || a2 || a3 || a4 || a5) active = true
            })

            // Step 2: Apply per-icon layout (vertical)
            let totalBarHeight = 0
            let currentFloatY = 0
            let lastRoundedY = 0

            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                // KEY FIX: always use widgetCache (revealer), never state.widget
                const gtkRev = widgetCache.get(id) as any
                if (!gtkRev) return
                const itemBox = (gtkRev.get_child ? gtkRev.get_child() : gtkRev) as any

                if (state.isSeparator) {
                    totalBarHeight += state.currentWidth
                    currentFloatY += state.currentWidth
                    const newRoundedY = Math.round(currentFloatY)
                    const slotH = newRoundedY - lastRoundedY
                    lastRoundedY = newRoundedY

                    if (gtkRev.height_request !== slotH) gtkRev.height_request = slotH
                    if (gtkRev.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                    gtkRev.halign = edgeAlign

                    const line = (itemBox as Gtk.CenterBox)?.get_center_widget() as Gtk.Box
                    if (line) line.set_size_request(Math.round(state.currentHeight * 0.7), DOCK_CONSTANTS.SEPARATOR_LINE)
                } else {
                    const exactMargin = state.currentMargin
                    const exactIconSize = DOCK_CONSTANTS.ICON_SIZE * state.currentScale
                    const exactSlotH = exactIconSize + (exactMargin * 2)
                    totalBarHeight += exactSlotH

                    currentFloatY += exactSlotH
                    const newRoundedY = Math.round(currentFloatY)
                    const slotH = newRoundedY - lastRoundedY
                    lastRoundedY = newRoundedY

                    const tps = Math.round(exactIconSize)
                    const remaining = slotH - tps
                    const marginT = Math.floor(remaining / 2)
                    const marginB = Math.ceil(remaining / 2)

                    // Revealer: height = slot, width = pill
                    if (gtkRev.height_request !== slotH) gtkRev.height_request = slotH
                    if (gtkRev.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.width_request = DOCK_CONSTANTS.PILL_HEIGHT

                    // itemBox: icon size + margins for centering within slot
                    if (itemBox) {
                        if (itemBox.height_request !== tps) itemBox.height_request = tps
                        if (itemBox.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) itemBox.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                        const vSlide = Math.round(state.currentSlideX)
                        if (itemBox.margin_top    !== marginT + vSlide) itemBox.margin_top    = marginT + vSlide
                        if (itemBox.margin_bottom !== marginB - vSlide) itemBox.margin_bottom = marginB - vSlide
                    }

                    // Nested icon sizing — overlay spans full pill width; icon centered within it
                    const overlay = itemBox?.get_first_child() as Gtk.Overlay
                    if (overlay) {
                        overlay.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, tps)
                        overlay.halign = Gtk.Align.FILL
                        const iconBox = overlay.get_child ? overlay.get_child() as Gtk.Box : null
                        if (iconBox) {
                            iconBox.set_size_request(tps, tps)
                            iconBox.halign = Gtk.Align.CENTER
                            iconBox.valign = Gtk.Align.CENTER
                            ;(iconBox as any).margin_bottom = 0
                            const icon = (iconBox as any).get_first_child()
                            if (icon) {
                                icon.set_size_request(tps, tps)
                                ;(icon as any).set_content_width?.(tps)
                                ;(icon as any).set_content_height?.(tps)
                            }
                        }
                    }
                }
            })

            // Step 3: Update bar height + input region
            const roundedTotalHeight = Math.round(totalBarHeight)
            if (active || smoothedBarHeight !== roundedTotalHeight) {
                smoothedBarHeight = roundedTotalHeight
                totalStaticHeight = roundedTotalHeight
                updateSize()
                updateInputRegion(smoothedBarHeight)
                active = true
            }

            // Step 4: Auto-hide slide — animate shim margin and DA drawing
            const slideDelta = slideTarget - slideCurrent
            const slideAbsDelta = Math.abs(slideDelta)
            const slideAbsVel   = Math.abs(slideVelocity)
            if (slideAbsDelta > 0.2 || slideAbsVel > 0.2) {
                const slideForce = SLIDE_STIFFNESS * slideDelta - SLIDE_DAMPING * slideVelocity
                slideVelocity += slideForce * dt
                slideCurrent  += slideVelocity * dt
                applyShimSlide()
                da.queue_draw()
                updateInputRegion(smoothedBarHeight)
                active = true
            } else if (slideCurrent !== slideTarget) {
                slideCurrent  = slideTarget
                slideVelocity = 0
                applyShimSlide()
                da.queue_draw()
                updateInputRegion(smoothedBarHeight)
            }

            if (!active) { tickId = null; return false }
            return true
        })
        if (seedFrame && da) da.queue_draw()
    }

    // Slide the whole dock window off the screen edge — identical mechanism to DockHorizontal's
    // set_margin(BOTTOM, -offset). Pill (DA) and icons (shim) move together since the window moves.
    const applyShimSlide = () => {
        if (!layerShellReady || PILL_SLIDE_DIST <= 0) return
        Gtk4LayerShell.set_margin(win, sideEdge, -Math.round(slideCurrent))
    }

    let lastMouseY = -1000
    const updateAllTargets = (mouseY: number, seedFrame = true) => {
        if (menuState.openCount > 0) return

        lastMouseY = mouseY
        const draggingId = dragBus.draggingId

        if (draggingId && previewIdx !== -1) {
            const relY = lastMouseY - lockedAxisStart
            const slotSize = DOCK_CONSTANTS.APP_SLOT
            let targetIdx = Math.floor(relY / slotSize)

            if (previewIdx !== -1) {
                const currentSlotCenterY = previewIdx * slotSize + slotSize / 2
                const distToCenter = relY - currentSlotCenterY
                if (Math.abs(distToCenter) < slotSize * 0.50) targetIdx = previewIdx
            }

            if (targetIdx < 0) targetIdx = 0
            if (targetIdx > currentTotalItems) targetIdx = currentTotalItems

            if (targetIdx !== previewIdx) {
                previewIdx = targetIdx
                update(true)
            }
        }

        // Vertical dock: no magnification — always rest state
        animRegistry.forEach((state) => {
            state.targetScale = 1.0
            if (state.isSeparator) {
                state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
                state.targetHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT
            } else {
                state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN
                state.targetHeight = DOCK_CONSTANTS.PILL_HEIGHT
            }
        })
        runUnifiedTick(seedFrame)
    }

    const updateInputRegion = (totalHeight: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

        if (appGridPanelOpen) { surface.set_input_region(null); return }

        const region = new Cairo.Region()

        if (fullscreenMode && !appGridPanelOpen && !isRevealed) {
            surface.set_input_region(region); return
        }

        const slideOff = Math.round(slideCurrent)

        if (dockSettings.autoHide && !isRevealed && slideOff >= PILL_SLIDE_DIST * 0.8) {
            // Window has slid off-screen by ~slideOff px. The screen edge (x=0 for left,
            // x=WIN_W-4 for right) maps to window coords shifted by slideOff.
            const TRIGGER_W = 4
            const edgeX = dockSettings.position === 'left' ? slideOff : WIN_W - TRIGGER_W - slideOff
            // @ts-ignore
            region.unionRectangle({ x: Math.max(0, edgeX), y: 0, width: TRIGGER_W, height: realizedH })
            surface.set_input_region(region); return
        }

        if (menuState.openCount > 0) { surface.set_input_region(null); return }

        const ph = totalHeight + DOCK_CONSTANTS.BASE_MARGIN * 2
        const py = Math.max(0, Math.round(getGtkCenter(realizedH) - ph / 2))
        const pillW = DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 50 // buffer for tooltips
        const edgeX = dockSettings.position === 'left' ? 0 : WIN_W - pillW
        // @ts-ignore
        region.unionRectangle({ x: edgeX, y: Math.max(0, py - 50), width: pillW, height: ph + 100 })
        surface.set_input_region(region)
    }

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        cursorInDock = true
        clearLeaveTimeout()
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            updateInputRegion(smoothedBarHeight)
        }
    })

    let leaveTimeout: number | null = null
    const clearLeaveTimeout = () => {
        if (leaveTimeout) { GLib.source_remove(leaveTimeout); leaveTimeout = null }
    }

    win.add_controller(motion)
    motion.connect("motion", (_controller, x, y) => {
        if (appGridPanelOpen) return
        if (fullscreenMode) return
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            updateInputRegion(smoothedBarHeight)
        }

        clearLeaveTimeout()

        if (dragBus.draggingId || isDndEnding) {
            updateAllTargets(y)
            return
        }

        // For vertical: x determines if cursor is on the pill side
        const xLimit = dockSettings.position === 'right'
            ? WIN_W - DOCK_CONSTANTS.EXCLUSIVE_ZONE
            : DOCK_CONSTANTS.EXCLUSIVE_ZONE
        const beyondPill = dockSettings.position === 'right' ? x < xLimit : x > xLimit
        if (beyondPill) {
            updateAllTargets(-1000)
        }
        // No magnification for vertical — just track Y for drag reorder
        lastMouseY = y
    })
    motion.connect("leave", () => {
        cursorInDock = false
        if (appGridPanelOpen) return
        if (dragBus.draggingId || isDndEnding) return

        clearLeaveTimeout()
        const magnDelay = 50
        const hideDelay = dockSettings.autoHide ? Math.max(magnDelay, dockSettings.hideDelay) : magnDelay
        leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, magnDelay, () => {
            leaveTimeout = null
            if (isDndEnding || dragBus.draggingId || appGridPanelOpen) return GLib.SOURCE_REMOVE
            updateAllTargets(-1000)
            if (dockSettings.autoHide) {
                if (hideDelay > magnDelay) {
                    leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideDelay - magnDelay, () => {
                        leaveTimeout = null
                        if (isDndEnding || dragBus.draggingId || menuState.openCount > 0 || appGridPanelOpen) return GLib.SOURCE_REMOVE
                        setRevealed(false)
                        updateInputRegion(smoothedBarHeight)
                        return GLib.SOURCE_REMOVE
                    })
                } else {
                    if (menuState.openCount === 0 && !appGridPanelOpen) {
                        setRevealed(false)
                        updateInputRegion(smoothedBarHeight)
                    }
                }
            }
            return GLib.SOURCE_REMOVE
        })
    })

    let updateLock = false
    let needsUpdate = false

    const update = (skipTargets = false) => {
        if (updateLock) { needsUpdate = true; return bar }
        updateLock = true
        try {
            const currentIconTheme = Theme.iconTheme
            if (currentIconTheme !== lastIconTheme) {
                widgetCache.clear()
                lastIconTheme = currentIconTheme
            }
            if (!tickId && menuState.openCount === 0) runUnifiedTick()

            if (menuState.openCount > 0 || status.isAnyOverlayOpen) {
                needsUpdate = true; return bar
            }

            needsUpdate = false
            const groupedClients: { [key: string]: { addresses: string[], displayClass: string, title: string } } = {}
            const sortedClients = [...hypr.clients].sort((a, b) => a.address.localeCompare(b.address))
            sortedClients.forEach(c => {
                const rawClass = c.class || ""
                const key = appService.resolveHyprlandClass(rawClass)
                if (!key) return
                if (!groupedClients[key]) groupedClients[key] = { addresses: [], displayClass: rawClass, title: c.title }
                groupedClients[key].addresses.push(c.address)
            })

            const currentGroupKeys = new Set(Object.keys(groupedClients))
            unpinnedOpenOrder.forEach((_, k) => { if (!currentGroupKeys.has(k)) unpinnedOpenOrder.delete(k) })
            currentGroupKeys.forEach(k => { if (!unpinnedOpenOrder.has(k)) unpinnedOpenOrder.set(k, unpinnedSeq++) })

            const draggingId = dragBus.draggingId
            let effectivePinnedList = [...pinnedState.list]
            let runningUnpinnedKeys: string[] = []
            const groupedKeys = Object.keys(groupedClients)
            const nsid = draggingId ? norm(draggingId) : ""

            if (draggingId && previewIdx !== -1) {
                if (draggingId !== lastDraggingId) {
                    lastDraggingId = draggingId
                    const currentPos = pinnedState.list.findIndex(p => norm(p) === nsid)
                    previewIdx = currentPos !== -1 ? currentPos + 2 : (2 + pinnedState.list.length + groupedKeys.length)
                }

                effectivePinnedList = effectivePinnedList.filter(p => norm(p) !== nsid)
                runningUnpinnedKeys = groupedKeys.filter(k => k !== nsid && k !== "home-shortcut" &&
                    !pinnedState.list.some(p => appMatch(k, norm(p))))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))

                const pinnedBoundary = 2 + effectivePinnedList.length
                if (previewIdx !== -1) {
                    if (previewIdx <= pinnedBoundary) {
                        let insertPos = previewIdx - 2
                        if (insertPos < 0) insertPos = 0
                        if (insertPos > effectivePinnedList.length) insertPos = effectivePinnedList.length
                        effectivePinnedList.splice(insertPos, 0, draggingId)
                    } else {
                        let insertPos = previewIdx - (pinnedBoundary + 1)
                        if (insertPos < 0) insertPos = 0
                        if (insertPos > runningUnpinnedKeys.length) insertPos = runningUnpinnedKeys.length
                        runningUnpinnedKeys.splice(insertPos, 0, nsid)
                    }
                }
            } else {
                lastDraggingId = ""
                runningUnpinnedKeys = groupedKeys.filter(k => k !== "home-shortcut" &&
                    !pinnedState.list.some(p => appMatch(k, norm(p))))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))
            }

            type ItemConfig = { id: string, width: number, syncData?: any, isPinned: boolean, factory: (vc: number) => Gtk.Widget, isSeparator?: boolean }
            const configs: ItemConfig[] = []
            const currentIds = new Set<string>()

            const getOrCreateItem = (id: string, factory: () => Gtk.Widget) => {
                currentIds.add(id)
                if (widgetCache.has(id)) return widgetCache.get(id)!
                const widget = factory()
                const isSep = id.startsWith("sep-")
                const revealer = new (Gtk as any).Revealer({
                    css_classes: ["cd-revealer"],
                    transition_type: dockSettings.position === 'left'
                        ? Gtk.RevealerTransitionType.SLIDE_RIGHT
                        : Gtk.RevealerTransitionType.SLIDE_LEFT,
                    transition_duration: 300,
                    child: widget,
                    reveal_child: firstRender,
                })
                revealer.set_overflow(Gtk.Overflow.VISIBLE)
                revealer.height_request = isSep ? DOCK_CONSTANTS.SEPARATOR_SLOT : DOCK_CONSTANTS.APP_SLOT
                revealer.width_request  = DOCK_CONSTANTS.PILL_HEIGHT
                revealer.halign = edgeAlign
                if (!firstRender) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { revealer.reveal_child = true; return GLib.SOURCE_REMOVE })
                widgetCache.set(id, revealer)
                return revealer
            }

            if (firstRender) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { firstRender = false; return GLib.SOURCE_REMOVE })
            }

            widgetCache.forEach(w => {
                const inner = (w as any).get_child?.()
                if (inner && (inner as any).popdown) (inner as any).popdown()
            })

            const findApp = (searchId: string) => appService.getResolvedApp(searchId)
            const userName = GLib.get_user_name()
            const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

            const homeItem = {
                name: prettyName,
                icon_name: ["finder", "system-file-manager", "user-home", "folder-home", "folder"],
                launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(print)
            }
            const homeAddrs = groupedClients["home-shortcut"]?.addresses || []
            configs.push({
                id: "home-shortcut", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: homeAddrs, clientTitle: undefined, appItem: homeItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({ appId: "home-shortcut", appItem: homeItem as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: homeAddrs,
                        clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: "home-shortcut" }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })
            delete groupedClients["home-shortcut"]

            const launcherItem = {
                name: t("dock.special.launcher.name"),
                icon_name: ["crys-grid", "view-app-grid-symbolic", "view-app-grid", "org.gnome.Shell.Apps-symbolic"],
                launch: () => { shellActions.toggleAppGrid?.() }
            }
            configs.push({
                id: "launcher", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: launcherItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({ appId: "launcher", appItem: launcherItem as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: [],
                        clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: "launcher" }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            effectivePinnedList.filter(id => !!id && !id.startsWith("special:") && id !== "trash" && id !== "launcher").forEach(id => {
                const lid = id.toLowerCase().replace(".desktop", "")
                const originalId = id.replace(".desktop", "")
                let appItem = findApp(id)
                const targetKey = lid
                const groupKey = Object.keys(groupedClients).find(k => appMatch(k, targetKey))
                let addrs: string[] = []
                let clientTitle = undefined

                if (groupKey && groupedClients[groupKey]) {
                    const group = groupedClients[groupKey]
                    addrs = group.addresses; clientTitle = group.title
                    delete groupedClients[groupKey]
                    if (!appItem) appItem = { name: clientTitle || group.displayClass, icon_name: originalId || lid, launch: getLaunch(lid) } as any
                    if (lid.startsWith("chrome-") && lid.endsWith("-default") && typeof (appItem as any).icon_name === "string")
                        (appItem as any).icon_name = (appItem as any).icon_name.replace(/-default$/i, "-Default")
                }

                if (appItem) {
                    if (lid.startsWith("chrome-") && lid.endsWith("-default"))
                        (appItem as any).icon_name = originalId.replace(/-default$/i, "-Default")
                    if (lid === "crystal-shell-settings") {
                        appItem.launch = () => { shellActions.toggleSettings?.() }
                    } else {
                        appItem.launch = getLaunch(lid)
                    }
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs, clientTitle, appItem: appItem! }, isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({ appId: lid, appItem: appItem!, updateDock: update,
                                register: (id, s) => animRegistry.set(id, s), addresses: addrs,
                                clientTitle, onPin, onUnpin, onReorder, isPinned: true, cleanId: lid }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                } else {
                    const info = appService.getAppInfo(lid)
                    const displayName = info?.get_name() || lid
                    let icon = info?.get_id() || originalId
                    if (lid.startsWith("chrome-") && lid.endsWith("-default") && typeof icon === "string")
                        icon = icon.replace(/-default$/i, "-Default")
                    const ghostLaunch = lid === "crystal-shell-settings"
                        ? () => { shellActions.toggleSettings?.() } : getLaunch(lid)
                    const ghost = { name: displayName, icon_name: icon, launch: ghostLaunch } as any
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs: [], clientTitle: undefined, appItem: ghost }, isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({ appId: lid, appItem: ghost, updateDock: update,
                                register: (id, s) => animRegistry.set(id, s), addresses: [],
                                clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: lid }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                }
            })

            if (runningUnpinnedKeys.length > 0) {
                const sepId = "sep-running"
                configs.push({
                    id: sepId, width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                    syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                    isPinned: true, isSeparator: true,
                    factory: (vc) => {
                        const w = Separator(sepId, update, (id, s) => animRegistry.set(id, s), onReorder)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            }

            runningUnpinnedKeys.forEach(k => {
                const group = groupedClients[k]
                const lid = k.toLowerCase().replace(".desktop", "")
                let appItem = findApp(lid) || findApp(group?.displayClass || "")
                if (!appItem) appItem = { name: group?.title || group?.displayClass || k, icon_name: lid, launch: getLaunch(lid) } as any
                if (lid === "crystal-shell-settings") appItem!.launch = () => { shellActions.toggleSettings?.() }
                configs.push({
                    id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                    syncData: { addrs: group?.addresses || [], clientTitle: group?.title, appItem: appItem! },
                    isPinned: false,
                    factory: (vc) => {
                        const w = DockItem({ appId: lid, appItem: appItem!, updateDock: update,
                            register: (id, s) => animRegistry.set(id, s), addresses: group?.addresses || [],
                            clientTitle: group?.title, onPin, onUnpin, onReorder, isPinned: false, cleanId: lid }, bar)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            })

            configs.push({
                id: "sep-trash", width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                isPinned: true, isSeparator: true,
                factory: (vc) => {
                    const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), onReorder)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            const trash = {
                name: t("dock.special.trash.name"),
                icon_name: ["user-trash", "trashcan-empty", "trash"],
                launch: () => execAsync("nautilus trash:///").catch(print)
            }
            configs.push({
                id: "special:trash", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: trash as any }, isPinned: true,
                factory: (vc) => {
                    const w = DockItem({ appId: "special:trash", appItem: trash as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: [],
                        clientTitle: undefined, onPin: () => {}, onUnpin: () => {}, onReorder: () => {},
                        isPinned: true, cleanId: "special:trash" }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            const processed = new Set<string>()
            const validConfigs = configs.filter(c => {
                if (processed.has(c.id)) return false
                processed.add(c.id); return true
            })

            // Slide-spring bookkeeping (reorder animation)
            const _slideOldPos = new Map<string, number>()
            const _slideOldSet = new Set(orderedIds)
            let _slideAccOld = 0
            orderedIds.forEach(id => {
                _slideOldPos.set(id, _slideAccOld)
                const s = animRegistry.get(id)
                _slideAccOld += s ? (s.currentWidth + s.currentMargin * 2) : DOCK_CONSTANTS.APP_SLOT
            })

            orderedIds = validConfigs.map(c => c.id)
            currentTotalItems = validConfigs.length
            totalStaticHeight = validConfigs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)

            const axisStart = Math.max(0, Math.round(getGtkCenter(realizedH) - totalStaticHeight / 2))
            let runningAxis = axisStart

            const finalItems = validConfigs.map((c) => {
                const slotH = c.width || DOCK_CONSTANTS.APP_SLOT
                const myCenter = runningAxis + (slotH / 2)
                runningAxis += slotH

                const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
                const state = animRegistry.get(c.id)
                if (state) state.staticCenter = myCenter

                const inner = (widget as any).get_child?.() ?? widget
                if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)
                if (inner && (inner as any).syncState && (c as any).syncData) {
                    const d = (c as any).syncData
                    ;(inner as any).syncState(d.addrs, d.clientTitle, d.appItem, c.isPinned)
                }
                return widget
            })

            for (const [id] of widgetCache) {
                if (!currentIds.has(id)) { widgetCache.delete(id); animRegistry.delete(id) }
            }

            // Reorder slide spring: detect position changes
            let _slideAccNew = 0
            orderedIds.forEach(id => {
                const s = animRegistry.get(id)
                const newY = _slideAccNew
                _slideAccNew += s ? (s.currentWidth + s.currentMargin * 2) : DOCK_CONSTANTS.APP_SLOT
                if (!s || !_slideOldSet.has(id)) return
                const oldY = _slideOldPos.get(id)
                if (oldY === undefined) return
                const disp = oldY - newY
                if (Math.abs(disp) > 1) {
                    s.currentSlideX = (s.currentSlideX || 0) + disp
                    s.velocitySlideX = 0; s.targetSlideX = 0
                    if (!tickId) runUnifiedTick()
                }
            })

            // Reconcile bar children
            let currentChild = bar.get_first_child()
            let prevSibling: Gtk.Widget | null = null
            finalItems.forEach(item => {
                if (currentChild !== item) {
                    if (item.get_parent() === bar) {
                        (bar as any).reorder_child_after(item, prevSibling)
                    } else {
                        if (item.get_parent()) item.unparent()
                        bar.insert_child_after(item, prevSibling)
                    }
                }
                prevSibling = item
                currentChild = item ? (item as any).get_next_sibling() : null
            })
            const finalSet = new Set(finalItems)
            let c = bar.get_first_child()
            while (c) {
                const next = c.get_next_sibling()
                if (!finalSet.has(c)) bar.remove(c)
                c = next
            }

            // Pre-apply rest-state layout so first tick has correct starting values
            let totalCurrentHeight = 0
            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                state.targetScale = 1.0
                if (state.isSeparator) {
                    state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
                    state.targetHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT
                } else {
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN
                    state.targetHeight = DOCK_CONSTANTS.PILL_HEIGHT
                }

                if (firstRender || !tickId) {
                    state.currentScale = state.targetScale
                    state.currentWidth = state.targetWidth
                    state.currentMargin = state.targetMargin

                    if (!state.isSeparator) {
                        const gtkRev = widgetCache.get(id) as any
                        if (gtkRev) {
                            const slotH = Math.round(state.currentWidth + 2 * state.currentMargin)
                            const tps   = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)
                            const mT = Math.floor((slotH - tps) / 2)
                            const mB = Math.ceil ((slotH - tps) / 2)
                            if (gtkRev.height_request !== slotH) gtkRev.height_request = slotH
                            if (gtkRev.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                            const itemBoxV = gtkRev.get_child?.()
                            if (itemBoxV) {
                                if (itemBoxV.height_request !== tps) itemBoxV.height_request = tps
                                if (itemBoxV.margin_top    !== mT)   itemBoxV.margin_top    = mT
                                if (itemBoxV.margin_bottom !== mB)   itemBoxV.margin_bottom = mB
                                const overlayV = itemBoxV.get_first_child?.()
                                if (overlayV) {
                                    overlayV.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, tps)
                                    overlayV.halign = Gtk.Align.FILL
                                    const iconBoxV = overlayV.get_child?.()
                                    if (iconBoxV) {
                                        iconBoxV.set_size_request(tps, tps)
                                        iconBoxV.halign = Gtk.Align.CENTER
                                        iconBoxV.valign = Gtk.Align.CENTER
                                        ;(iconBoxV as any).margin_bottom = 0
                                    }
                                }
                            }
                        }
                    }
                }
                totalCurrentHeight += state.currentWidth + (state.currentMargin * 2)
            })

            if (firstRender || !tickId) {
                smoothedBarHeight = totalCurrentHeight
                updateSize()
                firstRender = false
            }

            if (!tickId) runUnifiedTick()
            if (!skipTargets) updateAllTargets(lastMouseY, false)
            updateSize()
            return bar
        } catch (e) {
            console.error("[DockV] Update error:", e)
            return bar
        } finally {
            updateLock = false
            if (needsUpdate) {
                needsUpdate = false
                GLib.timeout_add(GLib.PRIORITY_LOW, 100, () => { update(); return GLib.SOURCE_REMOVE })
            }
        }
    }

    win.set_default_size(WIN_W, WIN_H)
    let layerInit = false
    let layerShellReady = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) {
        console.warn("Gtk4LayerShell init failed: " + e)
    }
    // Fixed height = usable area (below bar). With SIDE+BOTTOM anchors, size_request sets
    // the actual window height. The compositor places the window at y=BAR_HEIGHT.
    win.set_size_request(WIN_W, WIN_H)
    win.set_decorated(false)

    try { (win as any).app_paintable = true } catch (e) {}

    if (layerInit) {
        try {
            Gtk4LayerShell.set_namespace(win, "crystal-dock")
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)

            // SIDE+TOP+BOTTOM anchors — full side span is required for Hyprland to honor
            // the exclusive zone on the side edge. Explicit set_size(WIN_W, WIN_H) prevents
            // the compositor from stretching the window to full screen height; it gives
            // exactly WIN_H so the centering formula (rh/2) stays correct.
            Gtk4LayerShell.set_anchor(win, sideEdge, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
            if ((Gtk4LayerShell as any).set_size) {
                (Gtk4LayerShell as any).set_size(win, WIN_W, WIN_H)
            }

            // Exclusive zone reserves the pill strip for tiled windows.
            Gtk4LayerShell.set_exclusive_zone(win, dockSettings.autoHide ? 0 : DOCK_CONSTANTS.EXCLUSIVE_ZONE)

            layerShellReady = true

            // Publish actual pill width so CC/NC/NotifPopups can offset correctly
            dockSideState.update(dockSettings.position, DOCK_CONSTANTS.EXCLUSIVE_ZONE)

            if (dockSettings.autoHide) {
                applyShimSlide()  // initial hidden position
            }

            win.connect("realize", () => {
                // realizedH starts as dockMonitorHeight-40 and is corrected by the DA draw
                // callback on the first frame (which receives the true compositor-given _h).
                // No need to read win.get_height() here — it returns the GTK default before
                // the compositor sends its configure event.
                updateInputRegion(smoothedBarHeight)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    isSettlingIn = false; return GLib.SOURCE_REMOVE
                })
            })
        } catch (e) { console.error(e) }
    }

    let updateTimer: number | null = null
    const throttledUpdate = () => {
        if (updateTimer) GLib.source_remove(updateTimer)
        updateTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            update(); updateTimer = null; return GLib.SOURCE_REMOVE
        })
    }

    const DOCK_PERMANENT_IDS = new Set(["home-shortcut", "launcher", "trash", "crystal-shell-settings"])
    const pruneOrphanedPins = () => {
        const before = pinnedState.list.length
        pinnedState.list = pinnedState.list.filter(id => {
            if (!id || id.startsWith("special:")) return true
            if (DOCK_PERMANENT_IDS.has(id.toLowerCase())) return true
            const found = !!appService.getAppInfo(id)
            if (!found) console.log(`[DockV] Pruning orphaned pin: "${id}"`)
            return found
        })
        if (pinnedState.list.length < before) savePinned()
    }

    const cConn = hs.connect("changed", throttledUpdate)
    const aConn = appService.connect(throttledUpdate)
    const appStructConn = appService.connectStructural(pruneOrphanedPins)
    const pinnedConn = onPinnedChanged(throttledUpdate)

    const overlayRecovery = () => { if (!status.isAnyOverlayOpen && needsUpdate) throttledUpdate() }
    status.connect("notify::cc-open", overlayRecovery)
    status.connect("notify::nc-open", overlayRecovery)
    status.connect("notify::prism-open", overlayRecovery)
    status.connect("notify::system-menu-open", overlayRecovery)
    status.connect("notify::overview-open", overlayRecovery)

    const pConn = pointerBus.onButtonReleased(() => {
        isDndEnding = true
        GLib.timeout_add(GLib.PRIORITY_HIGH, 700, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    })

    const mConn = onMenuCountChanged((count) => {
        if (count !== 0) return
        updateAllTargets(-1000)
        runUnifiedTick(true)
        if (dockSettings.autoHide && isRevealed) {
            clearLeaveTimeout()
            leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, dockSettings.hideDelay, () => {
                leaveTimeout = null
                if (menuState.openCount > 0 || isDndEnding || dragBus.draggingId) return GLib.SOURCE_REMOVE
                setRevealed(false)
                updateInputRegion(smoothedBarHeight)
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const dConn = dragBus.subscribe((draggingId) => {
        if (draggingId) {
            dndActive = true
            const nsid = norm(draggingId)
            let virtualPinned = [...pinnedState.list]
            if (!virtualPinned.some(p => norm(p) === nsid)) virtualPinned.push(draggingId)
            lockedStaticHeight = calculateStableHeight(virtualPinned)
            lockedAxisStart = Math.max(0, Math.round(getGtkCenter(realizedH) - lockedStaticHeight / 2))
            const currentIdx = pinnedState.list.findIndex(p => norm(p) === nsid)
            if (currentIdx !== -1) previewIdx = currentIdx + 2
            else previewIdx = 2 + pinnedState.list.length
            throttledUpdate()
        } else {
            if (previewIdx >= 0 && lastDraggingId && lastMouseY >= 0) {
                onReorder(lastDraggingId)
            } else {
                previewIdx = -1
                isDndEnding = true
                update()
                GLib.timeout_add(GLib.PRIORITY_HIGH, 400, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
            }
            GLib.timeout_add(GLib.PRIORITY_HIGH, 200, () => { dndActive = false; return GLib.SOURCE_REMOVE })
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (!dragBus.draggingId) {
                    lastDraggingId = ""; previewIdx = -1
                    if (lastMouseY < 0) updateAllTargets(-1000)
                    update()
                }
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const sConn = onDockSettingsChanged(() => {
        syncConstants()
        animRegistry.forEach((state) => {
            if (state.isSeparator) {
                state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.currentWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.velocityWidth = 0
                state.targetHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT; state.currentHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT; state.velocityHeight = 0
            } else {
                state.targetScale = 1.0; state.currentScale = 1.0; state.velocityScale = 0
                state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.currentWidth = DOCK_CONSTANTS.ICON_SIZE; state.velocityWidth = 0
                state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN; state.currentMargin = DOCK_CONSTANTS.ICON_MARGIN; state.velocityMargin = 0
                state.targetHeight = DOCK_CONSTANTS.PILL_HEIGHT; state.currentHeight = DOCK_CONSTANTS.PILL_HEIGHT; state.velocityHeight = 0
            }
        })
        // Recalculate slide distance after constants change
        PILL_SLIDE_DIST = DOCK_CONSTANTS.EXCLUSIVE_ZONE + dockSettings.screenGap
        if (!isRevealed) { slideTarget = PILL_SLIDE_DIST; slideCurrent = PILL_SLIDE_DIST }
        // Update shim margin for new screenGap (no slide adjustment — bar.opacity handles hide)
        if (dockSettings.position === 'left') {
            shim.margin_start = dockSettings.screenGap
        } else {
            shim.margin_end = dockSettings.screenGap
        }
        const zone = (!isRevealed && dockSettings.autoHide) ? 0 : DOCK_CONSTANTS.EXCLUSIVE_ZONE
        if (layerShellReady) Gtk4LayerShell.set_exclusive_zone(win, zone)
        dockSideState.update(dockSettings.position, zone)
        update()
    })

    win.connect("destroy", () => {
        if (tickId) { bar.remove_tick_callback(tickId); tickId = null }
        if (updateTimer) { GLib.source_remove(updateTimer); updateTimer = null }
        if (leaveTimeout) { GLib.source_remove(leaveTimeout); leaveTimeout = null }
        try { if (cConn) hs.disconnect(cConn) } catch (e) {}
        try { if (aConn) aConn() } catch (e) {}
        try { if (pConn) pConn() } catch (e) {}
        try { if (dConn) dConn() } catch (e) {}
        try { if (sConn) sConn() } catch (e) {}
        try { if (mConn) mConn() } catch (e) {}
        try { appStructConn() } catch (e) {}
        try { pinnedConn() } catch (e) {}
    })

    ;(win as any).setLauncherMode = (active: boolean) => {
        if (!layerShellReady) return
        if (active) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            if (dockSettings.autoHide && !isRevealed) {
                isRevealed = true; slideTarget = 0; runUnifiedTick(true)
            }
        } else {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            updateInputRegion(smoothedBarHeight)
            if (dockSettings.autoHide && !cursorInDock) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    if (!cursorInDock && menuState.openCount === 0) {
                        setRevealed(false); updateInputRegion(smoothedBarHeight)
                    }
                    return GLib.SOURCE_REMOVE
                })
            }
        }
    }

    // ── Embedded AppGrid panel ────────────────────────────────────────────────
    let appGridPanelOpen = false

    const appGrid = AppGridPanel(gdkmonitor, () => closeAppGridPanel())
    appGrid.setKeyboardModeCallback(
        () => { if (layerShellReady) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE) },
        () => { if (layerShellReady) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND) }
    )

    appGrid.widget.visible = false
    appGrid.widget.halign  = Gtk.Align.CENTER
    appGrid.widget.valign  = Gtk.Align.CENTER
    windowOverlay.add_overlay(appGrid.widget)

    const openAppGridPanel = () => {
        if (appGridPanelOpen) return
        clearLeaveTimeout()
        appGridPanelOpen = true
        win.set_focusable(true)
        win.set_focus_visible(true)
        if (layerShellReady) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
        }
        appGrid.widget.visible = true
        appGrid.onShow()
        const surface = win.get_native()?.get_surface()
        if (surface) surface.set_input_region(null)
        if (!isRevealed) { setRevealed(true); runUnifiedTick(true) }
    }

    const closeAppGridPanel = () => {
        if (!appGridPanelOpen) return
        appGridPanelOpen = false
        appGrid.widget.visible = false
        appGrid.setActive(false)
        win.set_focus(null)
        win.set_focusable(false)
        win.set_focus_visible(false)
        if (layerShellReady) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
        }
        if (fullscreenMode && !cursorInDock) setRevealed(false)
        else if (dockSettings.autoHide && !cursorInDock) setRevealed(false)
        updateInputRegion(smoothedBarHeight)
    }

    ;(win as any).toggleAppGridPanel = () => {
        if (appGridPanelOpen) closeAppGridPanel()
        else openAppGridPanel()
    }

    const bgClickGesture = new Gtk.GestureClick()
    bgClickGesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
    bgClickGesture.connect("released", (_gesture: any, _n: number, x: number, y: number) => {
        if (!appGridPanelOpen) return
        const a = appGrid.widget.get_allocation()
        const inSquircle = x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height
        const pillW = DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 20
        const inDockStrip = dockSettings.position === 'left' ? x < pillW : x > WIN_W - pillW
        if (!inSquircle && !inDockStrip) closeAppGridPanel()
    })
    windowOverlay.add_controller(bgClickGesture)

    const appGridKeyCtrl = new Gtk.EventControllerKey()
    appGridKeyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    appGridKeyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
        if (!appGridPanelOpen) return false
        return appGrid.handleKey(keyval)
    })
    win.add_controller(appGridKeyCtrl)

    // ── Fullscreen detection ──────────────────────────────────────────────────
    let fullscreenMode = false
    let trackedClient: any = null
    let trackedClientConn: number | null = null

    const setFullscreenMode = (active: boolean) => {
        if (fullscreenMode === active) return
        fullscreenMode = active
        if (active && !appGridPanelOpen) {
            if (isRevealed) setRevealed(false)
            updateInputRegion(smoothedBarHeight)
        } else if (!active) {
            if (!dockSettings.autoHide || cursorInDock) { setRevealed(true); runUnifiedTick(true) }
            updateInputRegion(smoothedBarHeight)
        }
    }

    const checkFullscreen = () => {
        const client = hs.focusedClient ?? null
        if (client !== trackedClient) {
            if (trackedClient && trackedClientConn !== null) {
                try { trackedClient.disconnect(trackedClientConn) } catch (_) {}
                trackedClientConn = null
            }
            trackedClient = client
            if (client) {
                trackedClientConn = client.connect("notify::fullscreen", () =>
                    setFullscreenMode(client.fullscreen ?? false))
            }
        }
        setFullscreenMode(client ? (client.fullscreen ?? false) : false)
    }

    hs.connect("changed", checkFullscreen)
    checkFullscreen()

    update()
    win.present()

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        win.set_focus_visible(false); win.set_focus(null)
        return GLib.SOURCE_REMOVE
    })

    return win
}
