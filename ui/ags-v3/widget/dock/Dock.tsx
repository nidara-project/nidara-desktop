import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import { calculateDockItemMetrics, DOCK_CONSTANTS, syncConstants, springStep, slideSpringStep } from "./DockPhysics"
import type { SpringChannel } from "./DockPhysics"
import appService from "../../core/AppService"
import { DockItem, Separator, dismissActiveDockMenu } from "./DockItem"
import { drawSquircle } from "../common/DrawingUtils"
import { hypr, appsService as apps, dragBus, mouseBus, pointerBus, savePinned, pinnedState, dockSettings, onDockSettingsChanged, menuState, onMenuCountChanged, dockSideState } from "./state"
import status from "../../core/Status"
import hs from "../../core/HyprlandState"
import Theme from "../../core/ThemeManager"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import AppGridPanel from "../app-grid/AppGrid"

// V127: Native Gtk Resolution

// V127: Native Gtk Resolution - No mapping needed

// --- PERSISTENCE Moved to state.ts ---

// --- MOUSE BUS FOR MAGNIFICATION Moved to shared state ---


export default function Dock(gdkmonitor: any) {
    const isVertical = dockSettings.position === 'left' || dockSettings.position === 'right'
    const BAR_HEIGHT = 40  // matches bar's exclusive_zone

    // Notify CC/NC/Popups of side dock width (or reset for bottom)
    // Published after layer-shell setup when WIN_W is known
    dockSideState.update(dockSettings.position, 0)  // reset first; updated after size known

    // V180: Sync initial width with pinned items to prevent "One-Time Jump" on startup
    const norm = (s: string) => (s || "").toLowerCase().replace(".desktop", "")

    // IDs with steam_app_ prefix are unique per-game and must never match "steam" (or any
    // other shorter ID) via substring. Without this guard, "steam_app_1172470".includes("steam")
    // would absorb all game windows under the pinned Steam client icon.
    const appMatch = (k: string, lid: string) =>
        k === lid || (
            !k.startsWith("steam_app_") && !lid.startsWith("steam_app_") &&
            (k.includes(lid) || lid.includes(k))
        )

    // V475: Synchronous Width Helper
    // This allows updateAllTargets and update to always see the same base width
    // regardless of when they are called.
    const calculateStableWidth = (effectivePinned: string[]) => {
        const groupedClients: { [key: string]: any } = {}
        hypr.clients.forEach(c => {
            if (!c.class) return
            if (c.class.toLowerCase().includes("ags")) return
            let key = c.class.toLowerCase()

            // V625: Mirror mapping logic from update()
            if (["org.gnome.nautilus", "nautilus", "thunar", "dolphin", "pcmanfm", "nemo", "nemo-desktop"].includes(key)) {
                key = "home-shortcut"
            }
            groupedClients[key] = true
        })

        const runningUnpinnedCount = Object.keys(groupedClients).filter(c =>
            c !== "home-shortcut" && // Already handled as special 
            c !== "launcher" &&
            c !== "trash" &&
            c !== "special:trash" &&
            !effectivePinned.some(p => norm(p) === c)
        ).length

        // Total = Launcher(1) + Home(1) + Pinned + Running + Trash(1) + sep-trash(1) + sep-running(0 or 1)
        const apps = 3 + effectivePinned.length + runningUnpinnedCount
        const separators = 1 + (runningUnpinnedCount > 0 ? 1 : 0)
        return (apps * DOCK_CONSTANTS.APP_SLOT) + (separators * DOCK_CONSTANTS.SEPARATOR_SLOT)
    }

    const initialPinned = [...pinnedState.list]
    let totalStaticWidth = calculateStableWidth(initialPinned)
    const widgetCache = new Map<string, Gtk.Widget>()
    let lastIconTheme = Theme.iconTheme
    let firstRender = true
    // V608: Initial Population for stable startup
    let orderedIds: string[] = []
    let smoothedBarWidth = totalStaticWidth
    let velocityBarWidth = 0
    let currentTotalItems = 0

    // Create Layout First
    const layout = new Gtk.Overlay({
        name: "cd-layout",
        css_classes: ["cd-layout"],
        halign: Gtk.Align.FILL,
        valign: isVertical ? Gtk.Align.FILL : Gtk.Align.END,
        vexpand: isVertical,
    })

    let previewIdx = -1
    let lastDraggingId = ""
    let lockedStaticWidth = 0
    let lockedStartX = 0
    // Grace period after a drop: Wayland sends a spurious pointer_leave to the dock as
    // part of DnD grab cleanup even though the cursor is still over the surface.
    // This flag suppresses the leave handler until the protocol cleanup is done.
    let isDndEnding = false
    let cursorInDock = false

    // Stable open-order tracking for unpinned apps.
    // Keys are assigned a monotonically-increasing sequence number the first time
    // they appear in groupedClients so unpinned icons stay in open order.
    const unpinnedOpenOrder = new Map<string, number>()
    let unpinnedSeq = 0

    const getLaunch = (lid: string) => {
        const app = appService.getAppData(lid)
        const desktopId = app?.id || lid
        // Use uwsm app -- gtk-launch so apps land in their own systemd scope.
        return () => execAsync(["uwsm", "app", "--", "gtk-launch", desktopId]).catch(print)
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

        // V510: RECOVERY & ZONE LOGIC
        let finalIdx = previewIdx
        if (finalIdx === -1) {
            console.warn(`[Dock] onReorder: previewIdx was -1 for ${nsid}. Re-calculating...`)
            const relX = lastMousePos - lockedStartX
            finalIdx = Math.floor(relX / DOCK_CONSTANTS.APP_SLOT)
        }

        // console.log(`[Dock] Drop COMMIT: ${nsid} -> Slot ${finalIdx}`)

        const wasPinned = pinnedState.list.some(p => norm(p) === nsid)
        const pinnedCount = pinnedState.list.filter(p => norm(p) !== nsid).length

        // Pinned Section Boundary: Launcher (0) + Home (1) + PinnedCount
        const pinnedBoundary = 2 + pinnedCount

        // ZONE DECISION:
        // Index 0: Launcher, Index 1: Home
        if (finalIdx === currentTotalItems - 1) { // Trash is last
            console.log(`[Dock] Dropped on TRASH. Unpinning.`)
            onUnpin(draggingId)
            return
        }
        if (finalIdx === 1) { // Home
            console.log(`[Dock] Dropped on HOME. Pinning.`)
            onPin(draggingId)
            return
        }

        // If finalIdx <= pinnedBoundary, the item is dropped into the Pinned Section.
        if (finalIdx <= pinnedBoundary) {
            console.log(`[Dock] Dropped in PINNED ZONE. Ensuring persistence.`)
            pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
            let insertIdx = finalIdx - 2 // Offset for Launcher/Home
            if (insertIdx < 0) insertIdx = 0
            if (insertIdx > pinnedState.list.length) insertIdx = pinnedState.list.length
            pinnedState.list.splice(insertIdx, 0, draggingId)
            savePinned()
        } else {
            console.log(`[Dock] Dropped in RUNNING ZONE.`)
            if (wasPinned) {
                console.log(`[Dock] Pinned item dragged to Running Zone -> UNPINNING.`)
                pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
                savePinned()
            }
            // Update open-order map to reflect the user's manual placement.
            // Build sorted list without the dragged item, insert it at toIdx, then
            // reassign sequence numbers so the sort in update() honours the new order.
            const sortedUnpinned = [...unpinnedOpenOrder.entries()]
                .sort((a, b) => a[1] - b[1])
                .map(([k]) => k)
                .filter(k => k !== nsid)
            let toIdx = Math.max(0, Math.min(finalIdx - (pinnedBoundary + 1), sortedUnpinned.length))
            sortedUnpinned.splice(toIdx, 0, nsid)
            sortedUnpinned.forEach((k, i) => unpinnedOpenOrder.set(k, i))
            unpinnedSeq = sortedUnpinned.length
        }

        // COMMIT: draggingId is already "" (GestureDrag.drag-end cleared it before dConn
        // called onReorder). Calling dragBus.setDragging("") here again would re-fire dConn
        // a second time → second update() → the visible dock rebuild. Just flip the sentinels
        // and call update() once.
        previewIdx = -1
        lastDraggingId = ""
        isDndEnding = true    // Blocks the leave handler for 600ms
        update()
        GLib.timeout_add(GLib.PRIORITY_HIGH, 600, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    }


    const dockMonitorWidth = gdkmonitor.get_geometry().width
    const dockMonitorHeight = gdkmonitor.get_geometry().height
    // For vertical: window spans available height (excluding top bar)
    const verticalUsableH = dockMonitorHeight - BAR_HEIGHT
    // For vertical: window is WINDOW_HEIGHT wide (matches horizontal window height)
    // giving icons room to grow toward the screen center, same logic as horizontal upward growth.
    const WIN_W = isVertical ? DOCK_CONSTANTS.WINDOW_HEIGHT : dockMonitorWidth
    const WIN_H = isVertical ? verticalUsableH : dockMonitorHeight
    const sideEdge = dockSettings.position === 'left' ? Gtk4LayerShell.Edge.LEFT : Gtk4LayerShell.Edge.RIGHT

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

    // Full-window overlay: dock strip (layout) as base child, appgrid panel as overlay
    const windowOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
    windowOverlay.set_child(layout)
    win.set_child(windowOverlay)
    const bar = new Gtk.Box({
        name: "cd-bar",
        css_classes: ["cd-bar"],
        spacing: 0,
        orientation: isVertical ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL,
        halign: isVertical
            ? (dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END)
            : Gtk.Align.START,
        valign: isVertical ? Gtk.Align.CENTER : Gtk.Align.END,
        overflow: isVertical ? Gtk.Overflow.VISIBLE : Gtk.Overflow.HIDDEN,
        hexpand: false,
        vexpand: false,
    })

    // Dismiss any open context menu when the user clicks anywhere on the dock bar.
    // Wayland doesn't send popup_done when clicking within the same layer surface,
    // so this is the manual fallback for that case.
    const barDismissClick = new Gtk.GestureClick({ button: 0 })
    barDismissClick.connect("pressed", () => { dismissActiveDockMenu() })
    bar.add_controller(barDismissClick)

    const da = new Gtk.DrawingArea({
        name: "dock-gloss-layer",
        valign: isVertical ? Gtk.Align.FILL : Gtk.Align.END,
        halign: isVertical ? Gtk.Align.FILL : Gtk.Align.START,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        margin_bottom: isVertical ? 0 : dockSettings.screenGap,
        can_focus: false,
    })

    Theme.connect("changed", () => da.queue_draw())

    da.set_draw_func((_, cr, w, _h) => {
        const dockAlpha = Theme.dockOpacity
        const dockColor = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        const borderCol = Theme.isDark ? { r: 1, g: 1, b: 1, a: 0.12 } : { r: 0, g: 0, b: 0, a: 0.08 }
        if (isVertical) {
            const pw = DOCK_CONSTANTS.PILL_HEIGHT
            const ph = smoothedBarWidth + DOCK_CONSTANTS.BASE_MARGIN * 2
            const px = dockSettings.position === 'right'
                ? WIN_W - DOCK_CONSTANTS.EXCLUSIVE_ZONE
                : dockSettings.screenGap
            const py = Math.max(0, Math.round((verticalUsableH - ph) / 2))
            cr.translate(px, py)
            drawSquircle(cr, pw, ph, undefined, dockAlpha, true, dockColor, undefined, false, borderCol, 3.2, 1.0, 0)
        } else {
            drawSquircle(cr, w, _h, undefined, dockAlpha, true, dockColor, undefined, false, borderCol, 3.2, 1.0, 0)
        }
    })

    let lastRenderedWidth = -1
    const updateSize = () => {
        if (!bar || !win) return
        // Skip all layout + repaint when dimensions haven't changed — prevents
        // needless Wayland surface damage and GPU blur recomputation at idle.
        if (smoothedBarWidth === lastRenderedWidth) return
        lastRenderedWidth = smoothedBarWidth
        if (isVertical) {
            bar.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, smoothedBarWidth)
            if (da) da.queue_draw()
        } else {
            bar.set_size_request(smoothedBarWidth, -1)
            const targetW = smoothedBarWidth + (DOCK_CONSTANTS.BASE_MARGIN * 2)
            if (da) { da.set_size_request(targetW, DOCK_CONSTANTS.PILL_HEIGHT); da.queue_draw() }
        }
    }

    // Pre-emptive centering: horizontal only (margin_start). Vertical uses valign=CENTER — GTK
    // centers the bar automatically so we don't fight with layout on the first frame.
    const initialMargin = Math.round((dockMonitorWidth - totalStaticWidth) / 2)
    if (!isVertical) {
        bar.margin_start = Math.max(0, initialMargin)
        if (da) da.margin_start = Math.max(0, initialMargin - DOCK_CONSTANTS.BASE_MARGIN)
    }

    // --- PHYSICS ENGINE ---
    const animRegistry = new Map<string, import("./state").AnimState>()

    let tickId: number | null = null

    // ── Auto-hide slide state ─────────────────────────────────────────────────
    // slideOffset: 0 = fully visible, >0 = hidden (off-screen by that many px)
    const initialHideTarget = isVertical
        ? WIN_W - 4
        : DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 4
    let isRevealed    = !dockSettings.autoHide
    let slideTarget   = dockSettings.autoHide ? initialHideTarget : 0
    let slideCurrent  = slideTarget   // start at final position — no intro animation
    let slideVelocity = 0
    const SLIDE_STIFFNESS = 500
    const SLIDE_DAMPING = 52

    // True while a DnD is in flight (from drag-start to 700ms after drag-end).
    // Blocks setRevealed(false) so the dock can't slide away during DnD cleanup
    // regardless of which leave handler path fires.
    let dndActive = false

    // Suppresses reveal from spurious pointer-enter events that Wayland fires when a
    // new window appears under the cursor (before the input region is restricted to the
    // 4px trigger strip). Cleared in the realize handler once the region is applied.
    let isSettlingIn = dockSettings.autoHide

    const setRevealed = (reveal: boolean) => {
        if (isRevealed === reveal) return
        if (!reveal && dndActive) return  // Never hide dock during DnD
        isRevealed = reveal
        slideTarget = reveal ? 0 : (isVertical
            ? WIN_W - 4   // leave 4px on-screen as the hover trigger strip
            : DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 4)

        // Vertical dock: never change exclusive_zone (stays 0) — it would push the bar.
        // Only horizontal dock toggles exclusive_zone on reveal/hide.
        if (layerShellReady && !isVertical) {
            Gtk4LayerShell.set_exclusive_zone(win, reveal ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0)
        }
        runUnifiedTick(true)
    }

    // seedFrame: only seed when newly registering from a user-driven path.
    // System event paths (notify::focused-client → update) pass false so they
    // never cause surface damage. Also, if the tick is already running the
    // seedFrame parameter is irrelevant — the guard returns early before it fires.
    const runUnifiedTick = (seedFrame = false) => {
        if (tickId !== null) return
        tickId = bar.add_tick_callback((_, clock) => {
            if (menuState.openCount > 0) return true

            if (orderedIds.length === 0) {
                tickId = null
                return false
            }

            const dt = 1 / 60
            let active = false


            // Step 1: Advance ALL icon springs
            // Springs act as temporal filters: they make float values change
            // gradually and proportionally, so integer boundary crossings
            // happen in a coordinated wave rather than one-at-a-time.
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

                if (a1 || a2 || a3 || a4) active = true
            })

            // Step 2: Apply per-icon layout + accumulate bar width
            let totalBarWidth = 0

            // V610: Subpixel Accumulator (1D Error Diffusion)
            // GTK4 requires integer dimensions. If we independently round each icon, the overall 
            // sequence vibrates as random icons flip between floor and ceil. By tracking the exact 
            // floating point X-coordinate of every edge and subtracting, we lock the integer layout 
            // perfectly to the continuous math model.
            let currentFloatX = 0
            let lastRoundedX = 0

            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                const widget = state.widget || widgetCache.get(id)
                if (!widget) return

                const revealer = widget as any
                const itemBox = revealer.get_child ? (revealer.get_child() as Gtk.Box) : revealer

                if (state.isSeparator) {
                    totalBarWidth += state.currentWidth
                    currentFloatX += state.currentWidth

                    const newRoundedX = Math.round(currentFloatX)
                    const slotW = newRoundedX - lastRoundedX
                    lastRoundedX = newRoundedX

                    if (isVertical) {
                        const edgeAlign = dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END
                        if (revealer.height_request !== slotW) revealer.height_request = slotW
                        if (revealer.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) revealer.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                        revealer.halign = edgeAlign
                        // Horizontal separator line in vertical mode
                        const centerBox = itemBox as Gtk.CenterBox
                        const line = centerBox?.get_center_widget() as Gtk.Box
                        if (line) line.set_size_request(Math.round(state.currentHeight * 0.7), DOCK_CONSTANTS.SEPARATOR_LINE)
                    } else {
                        if (revealer.width_request !== slotW) revealer.width_request = slotW
                        const centerBox = itemBox as Gtk.CenterBox
                        const line = centerBox?.get_center_widget() as Gtk.Box
                        if (line) line.set_size_request(-1, Math.round(state.currentHeight))
                    }
                } else {
                    const exactMargin = state.currentMargin
                    const exactIconSize = DOCK_CONSTANTS.ICON_SIZE * state.currentScale

                    const exactSlotW = exactIconSize + (exactMargin * 2)
                    totalBarWidth += exactSlotW

                    currentFloatX += exactSlotW
                    const newRoundedX = Math.round(currentFloatX)
                    const slotW = newRoundedX - lastRoundedX
                    lastRoundedX = newRoundedX

                    const tps = Math.round(exactIconSize)
                    const remaining = slotW - tps
                    const marginL = Math.floor(remaining / 2)
                    const marginR = Math.ceil(remaining / 2)

                    if (isVertical) {
                        // Mirror of horizontal: slot axis = height, overflow axis = width.
                        // Revealer height = slotW (grows), width = PILL_HEIGHT (fixed like horizontal height).
                        // itemBox height = tps (grows), width = PILL_HEIGHT (fixed like horizontal height).
                        // Icon overflows outward (toward screen center) via overflow=VISIBLE.
                        if (revealer.height_request !== slotW) revealer.height_request = slotW
                        if (revealer.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) revealer.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                        // Sync the actual GTK Revealer wrapper too
                        const gtkRev = widgetCache.get(id) as any
                        if (gtkRev && gtkRev !== (revealer as any)) {
                            if (gtkRev.height_request !== slotW) gtkRev.height_request = slotW
                            if (gtkRev.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) gtkRev.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                        }
                        if (itemBox) {
                            // Only height changes (slot axis); width stays PILL_HEIGHT from constructor.
                            if (itemBox.height_request !== tps) itemBox.height_request = tps
                            // Slide spring along vertical axis (currentSlideX reused as axis offset)
                            const vSlide = Math.round(state.currentSlideX)
                            const vtML = marginL + vSlide
                            const vtMR = marginR - vSlide
                            if (itemBox.margin_top !== vtML) itemBox.margin_top = vtML
                            if (itemBox.margin_bottom !== vtMR) itemBox.margin_bottom = vtMR
                        }
                    } else {
                        if (revealer.width_request !== slotW) revealer.width_request = slotW
                        if (itemBox) {
                            if (itemBox.width_request !== tps) itemBox.width_request = tps
                            // Slide spring: offset the icon within the slot so it appears to glide
                            // from its old position to the new one after a DOM reorder.
                            const hSlide = Math.round(state.currentSlideX)
                            const htML = marginL + hSlide
                            const htMR = marginR - hSlide
                            if (itemBox.margin_start !== htML) itemBox.margin_start = htML
                            if (itemBox.margin_end !== htMR) itemBox.margin_end = htMR
                            itemBox.margin_bottom = Math.round(0 - (state.currentTranslateY || 0))
                        }
                    }

                    // Visual nested sizing
                    const overlay = itemBox?.get_first_child() as Gtk.Overlay
                    if (overlay) {
                        if (isVertical) {
                            // Square overlay — icon grows in both axes, anchored to screen edge
                            const edgeAlign = dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END
                            overlay.set_size_request(tps, tps)
                            overlay.halign = edgeAlign
                        }
                        const iconBox = overlay.get_child() as Gtk.Box
                        if (iconBox) {
                            iconBox.set_size_request(tps, tps)
                            if (isVertical) {
                                const edgeAlign = dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END
                                iconBox.halign = edgeAlign
                                iconBox.valign = Gtk.Align.CENTER
                                iconBox.margin_bottom = 0
                            }
                            const plateOverlay = iconBox.get_first_child() as Gtk.Overlay
                            if (plateOverlay && plateOverlay.get_child) {
                                const da = plateOverlay.get_child()
                                if (da) {
                                    da.set_size_request(tps, tps)
                                    const icon = (da as any).get_next_sibling()
                                    if (icon) icon.set_size_request(tps, tps)
                                }
                            } else {
                                const icon = iconBox.get_first_child()
                                if (icon) icon.set_size_request(tps, tps)
                            }
                        }
                    }
                }
            })

            // Step 3: Bar position (horizontal: margin_start; vertical: handled by valign=CENTER)
            const roundedTotalWidth = Math.round(totalBarWidth)

            if (!isVertical) {
                const barM = Math.round((dockMonitorWidth - roundedTotalWidth) / 2)
                if (bar.margin_start !== barM) {
                    bar.margin_start = barM
                    if (da) da.margin_start = barM - DOCK_CONSTANTS.BASE_MARGIN
                }
            }

            if (active || smoothedBarWidth !== roundedTotalWidth) {
                smoothedBarWidth = roundedTotalWidth
                updateSize()
                updateInputRegion(smoothedBarWidth)
                active = true
            }

            // Step 4: Slide spring (auto-hide)
            const slideDelta = slideTarget - slideCurrent
            const slideAbsDelta = Math.abs(slideDelta)
            const slideAbsVel = Math.abs(slideVelocity)
            if (slideAbsDelta > 0.2 || slideAbsVel > 0.2) {
                const slideForce = SLIDE_STIFFNESS * slideDelta - SLIDE_DAMPING * slideVelocity
                slideVelocity += slideForce * dt
                slideCurrent += slideVelocity * dt
                const offset = Math.round(slideCurrent)
                if (isVertical) {
                    if (layerShellReady) Gtk4LayerShell.set_margin(win, sideEdge, -offset)
                } else {
                    if (layerShellReady) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, -offset)
                }
                // Update input region during slide so trigger strip activates once 80% hidden.
                updateInputRegion(smoothedBarWidth)
                active = true
            } else if (slideCurrent !== slideTarget) {
                slideCurrent = slideTarget
                slideVelocity = 0
                if (isVertical) {
                    if (layerShellReady) Gtk4LayerShell.set_margin(win, sideEdge, -Math.round(slideTarget))
                } else {
                    if (layerShellReady) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, -Math.round(slideTarget))
                }
                updateInputRegion(smoothedBarWidth)
            }

            if (!active) {
                tickId = null
                return false
            }
            return true
        })
        if (seedFrame && da) da.queue_draw()
    }

    let lastMousePos = -1000
    const updateAllTargets = (mousePos: number, seedFrame = true) => {
        // V320: Freeze magnification shifts while a menu is open to prevent "ghost menu" flickering
        if (menuState.openCount > 0) return

        const screenWidth = gdkmonitor.get_geometry().width
        lastMousePos = mousePos

        // Static centers are in dock-axis coordinates (X for horizontal, Y for vertical).
        const pX = lastMousePos

        const draggingId = dragBus.draggingId
        // Only enter drag-slot logic when actively previewing (previewIdx !== -1).
        // When previewIdx === -1 the drop was committed but drag-end hasn't cleared
        // draggingId yet — we treat it as the resting state so the leave guard holds.
        if (draggingId && previewIdx !== -1) {
            // V480: STATIC LOGIC ANCHOR
            // We use the startX captured when the drag began for the GRID.
            // This makes slot calculation absolute and immune to visual shifts.
            const relX = lastMousePos - lockedStartX

            // V482: 50% STICKY SLOT HYSTERESIS
            const slotSize = DOCK_CONSTANTS.APP_SLOT
            // Re-calculate targetIdx with fresh logic
            let targetIdx = Math.floor(relX / slotSize)

            if (previewIdx !== -1) {
                const currentSlotCenterX = previewIdx * slotSize + slotSize / 2
                const distToCenter = relX - currentSlotCenterX
                if (Math.abs(distToCenter) < slotSize * 0.50) {
                    targetIdx = previewIdx
                }
            }

            // V518: SCALE GRIDS FOR TOTAL COUNT
            const total = currentTotalItems || 10
            if (targetIdx < 0) targetIdx = 0
            if (targetIdx > total) targetIdx = total

            if (targetIdx !== previewIdx) {
                previewIdx = targetIdx
                update(true)
            }

            // V535: HOVER RESTORATION
            // Map targetIdx back to an appId to restore plates/visual feedback
            // For now, clear hover if out of bounds, else set it.
            // (Detailed mapping is complex, simplest is to let magnification guide it)
            const hoverTotal = currentTotalItems || 10
            if (targetIdx >= 0 && targetIdx <= hoverTotal) {
                // We'll let update() loop handle the mapping or do a rough estimate
            } else {
                dragBus.clearHover()
            }
        }

        animRegistry.forEach((state, id) => {
            if (pX === -1000) {
                state.targetScale = 1.0
                if (state.isSeparator) {
                    state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
                } else {
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN
                }
            } else {
                // If dragging, we use the projected mouse to hit the static slots
                const metrics = calculateDockItemMetrics(
                    pX,
                    state.staticCenter,
                    state.isSeparator
                )
                state.targetScale = metrics.scale
                state.targetWidth = metrics.width
                state.targetHeight = metrics.height || DOCK_CONSTANTS.PILL_HEIGHT
                state.targetMargin = metrics.margin
                state.targetTranslateY = metrics.translateY
            }
        })
        runUnifiedTick(seedFrame)
    }

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        cursorInDock = true
        // Cancel any pending hide timeout immediately on re-enter.
        // Hyprland sends a spurious wl_pointer.leave after a click/drag-release and then
        // immediately a wl_pointer.enter (cursor never actually left). Without this, the
        // leaveTimeout would fire 500ms later and slide the dock away.
        clearLeaveTimeout()
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            updateInputRegion(smoothedBarWidth)
        }
    })
    const updateInputRegion = (totalWidth: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

        // AppGrid open: full window must receive input (panel + dock strip)
        if (appGridPanelOpen) {
            surface.set_input_region(null)
            return
        }

        const region = new Cairo.Region()

        // Vertical dock: restrict input to pill area, or thin edge when hidden
        if (isVertical) {
            if (dockSettings.autoHide && !isRevealed && slideTarget > 0) {
                // Hidden: the window is slid (WIN_W - 4)px off-screen, leaving the last
                // 4px on screen as a hover trigger. In window coords:
                //   left dock:  rightmost 4px = x = WIN_W - 4
                //   right dock: leftmost 4px  = x = 0
                const edgeX = dockSettings.position === 'left' ? WIN_W - 4 : 0
                // @ts-ignore
                region.unionRectangle({ x: edgeX, y: 0, width: 4, height: WIN_H })
            } else {
                // Visible: include the full overflow zone (icons grow toward screen center)
                // plus the pill area. Restrict Y to pill area so transparent space above/below
                // passes clicks through to underlying windows.
                const ph = smoothedBarWidth + DOCK_CONSTANTS.BASE_MARGIN * 2
                const py = Math.max(0, Math.round((verticalUsableH - ph) / 2))
                // @ts-ignore
                region.unionRectangle({ x: 0, y: py, width: WIN_W, height: ph })
            }
            surface.set_input_region(region)
            return
        }

        // When auto-hide is on and dock is hidden, expose only a thin strip at
        // the screen edge. The window is pushed down by initialHideTarget px so the
        // screen edge falls at y = WINDOW_HEIGHT - initialHideTarget in window coords.
        //
        // Only activate the trigger strip once the dock is ≥80% hidden. During the
        // early part of the hide animation the strip sits in the overflow zone above the
        // pill in screen-space, so a cursor moving upward would pass through it and
        // immediately re-reveal the dock — cancelling the hide and keeping icons magnified.
        // In fullscreen mode (no appgrid open), expose no trigger — cursor cannot re-reveal
        if (fullscreenMode && !appGridPanelOpen && !isRevealed) {
            surface.set_input_region(region) // empty region
            return
        }

        if (dockSettings.autoHide && !isRevealed && slideTarget > 0
                && slideCurrent >= initialHideTarget * 0.8) {
            const triggerY = WIN_H - Math.round(initialHideTarget) - 4
            // @ts-ignore
            region.unionRectangle({ x: 0, y: triggerY, width: dockMonitorWidth, height: 4 })
            surface.set_input_region(region)
            return
        }

        // V421: SMART INPUT REGION — full window while menu is open
        if (menuState.openCount > 0) {
            surface.set_input_region(null)
            return
        }

        // V422: GENEROUS INPUT REGION — expanded zone for smooth magnification onset
        const width = totalWidth + 500
        const x = (dockMonitorWidth - width) / 2
        const y = WIN_H - DOCK_CONSTANTS.PILL_HEIGHT

        // @ts-ignore
        region.unionRectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: DOCK_CONSTANTS.PILL_HEIGHT })
        surface.set_input_region(region)
    }

    let leaveTimeout: number | null = null
    const clearLeaveTimeout = () => {
        if (leaveTimeout) {
            GLib.source_remove(leaveTimeout)
            leaveTimeout = null
        }
    }

    win.add_controller(motion)
    motion.connect("motion", (controller, x, y) => {
        // AppGrid open: dock doesn't respond to mouse (panel handles its own events)
        if (appGridPanelOpen) return
        // Fullscreen mode: cursor cannot interact with dock
        if (fullscreenMode) return
        // Auto-hide: reveal dock on any mouse entry (skip spurious events before realize)
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            updateInputRegion(smoothedBarWidth)
        }

        if (isVertical) {
            if (!dragBus.draggingId) {
                // xLimit is the pill's screen-edge boundary in window coords.
                // Equivalent to yLimit in horizontal: cursor beyond the normal pill area
                // (in the overflow zone only) resets magnification.
                const xLimit = dockSettings.position === 'right'
                    ? WIN_W - DOCK_CONSTANTS.EXCLUSIVE_ZONE
                    : DOCK_CONSTANTS.EXCLUSIVE_ZONE
                const beyondPill = dockSettings.position === 'right' ? x < xLimit : x > xLimit
                if (beyondPill) {
                    updateAllTargets(-1000)
                } else {
                    clearLeaveTimeout()  // only cancel leave timer when cursor is inside the pill
                    // Convert window-absolute Y to bar-relative Y so staticCenter (bar-relative)
                    // and cursor Y are in the same coordinate space.
                    const barTop = Math.max(0, Math.round((verticalUsableH - smoothedBarWidth) / 2))
                    updateAllTargets(y - barTop)
                }
            }
            return
        }

        clearLeaveTimeout()

        if (dragBus.draggingId || isDndEnding) {
            updateAllTargets(x)
            return
        }

        const yLimit = WIN_H - DOCK_CONSTANTS.PILL_HEIGHT
        if (y < yLimit) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        cursorInDock = false
        if (appGridPanelOpen) return  // keep dock revealed while panel is open
        if (dragBus.draggingId || isDndEnding) return

        clearLeaveTimeout()
        const magnDelay = 50
        const hideDelay = dockSettings.autoHide ? Math.max(magnDelay, dockSettings.hideDelay) : magnDelay
        leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, magnDelay, () => {
            leaveTimeout = null
            // Re-check: a drag-end or click may have set isDndEnding AFTER the leave event
            // fired (Wayland can include wl_pointer.leave before wl_pointer.button.released
            // in the same frame). If protection is active, abort the hide — a genuine leave
            // will create a new timeout once the protection expires.
            if (isDndEnding || dragBus.draggingId || appGridPanelOpen) return GLib.SOURCE_REMOVE
            updateAllTargets(-1000)
            if (dockSettings.autoHide) {
                if (hideDelay > magnDelay) {
                    leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideDelay - magnDelay, () => {
                        leaveTimeout = null
                        if (isDndEnding || dragBus.draggingId || menuState.openCount > 0 || appGridPanelOpen) return GLib.SOURCE_REMOVE
                        setRevealed(false)
                        updateInputRegion(smoothedBarWidth)
                        return GLib.SOURCE_REMOVE
                    })
                } else {
                    if (menuState.openCount === 0 && !appGridPanelOpen) {
                        setRevealed(false)
                        updateInputRegion(smoothedBarWidth)
                    }
                }
            }
            return GLib.SOURCE_REMOVE
        })
    })

    const shim = new Gtk.Box({
        valign: isVertical ? Gtk.Align.FILL : Gtk.Align.END,
        halign: isVertical
            ? (dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END)
            : Gtk.Align.START,
        margin_bottom: isVertical ? 0 : dockSettings.screenGap,
        margin_start: isVertical && dockSettings.position === 'left'  ? dockSettings.screenGap : 0,
        margin_end:   isVertical && dockSettings.position === 'right' ? dockSettings.screenGap : 0,
        height_request: isVertical ? -1 : DOCK_CONSTANTS.PILL_HEIGHT,
        vexpand: isVertical,
        overflow: Gtk.Overflow.VISIBLE,
    })
    if (!isVertical) bar.valign = Gtk.Align.END
    shim.append(bar)

    // No drop target needed — drag is handled by GestureDrag in DockItem (not Wayland DnD).
    // The dock's own motion.connect("motion") handler tracks cursor position during gesture drag
    // because GestureDrag is a plain pointer gesture, not a wl_data_device grab.

    // V136: Architecture Simplification
    // The DrawingArea is now the primary child (Background), removing 'pillBg' to prevent double backgrounds.
    layout.set_child(da)
    layout.add_overlay(shim)


    let updateLock = false
    let needsUpdate = false

    const update = (skipTargets = false) => {
        if (updateLock) {
            needsUpdate = true
            return bar
        }
        updateLock = true
        try {
            // If the icon theme changed, flush the cache so DockItems are recreated with fresh pixbufs
            const currentIconTheme = Theme.iconTheme
            if (currentIconTheme !== lastIconTheme) {
                widgetCache.clear()
                lastIconTheme = currentIconTheme
            }
            // Run the animation tick regardless of overlay state — it only moves existing
            // widgets and is safe to run at any time. Skip only when a context menu is open
            // (menuState.openCount > 0) because then we want to freeze the dock pill to
            // prevent it from shrinking and visually clipping the visible menu.
            if (!tickId && menuState.openCount === 0) runUnifiedTick()

            // V310: PROTECTION. Skip widget-tree reconciliation while a context menu or
            // fullscreen overlay is active to prevent layout shifts ("ghost menu" fix).
            if (menuState.openCount > 0 || status.isAnyOverlayOpen) {
                needsUpdate = true // Try again after overlay closes
                return bar
            }

            needsUpdate = false
            const groupedClients: { [key: string]: { addresses: string[], displayClass: string, title: string } } = {}
            const sortedClients = [...hypr.clients].sort((a, b) => a.address.localeCompare(b.address))
            sortedClients.forEach(c => {
                const rawClass = c.class || ""
                const key = appService.resolveHyprlandClass(rawClass)
                if (!key) return


                if (!groupedClients[key]) {
                    groupedClients[key] = { addresses: [], displayClass: rawClass, title: c.title }
                }
                groupedClients[key].addresses.push(c.address)
            })

            // Maintain stable open-order: evict closed apps, register new ones
            const currentGroupKeys = new Set(Object.keys(groupedClients))
            unpinnedOpenOrder.forEach((_, k) => { if (!currentGroupKeys.has(k)) unpinnedOpenOrder.delete(k) })
            currentGroupKeys.forEach(k => { if (!unpinnedOpenOrder.has(k)) unpinnedOpenOrder.set(k, unpinnedSeq++) })

            const draggingId = dragBus.draggingId
            const hoverId = dragBus.hoverId

            // V515: DUAL-ZONE LOGIC
            let effectivePinnedList = [...pinnedState.list]
            let runningUnpinnedKeys: string[] = []

            const groupedKeys = Object.keys(groupedClients)
            const nsid = draggingId ? norm(draggingId) : ""

            // Only enter drag-preview mode if actively dragging AND previewIdx is valid.
            // After onReorder commits a drop it sets previewIdx=-1 but leaves draggingId
            // set so the leave handler stays blocked until drag-end fires.
            if (draggingId && previewIdx !== -1) {
                if (draggingId !== lastDraggingId) {
                    lastDraggingId = draggingId
                    const currentPos = pinnedState.list.findIndex(p => norm(p) === nsid)
                    previewIdx = currentPos !== -1 ? currentPos + 2 : (2 + pinnedState.list.length + groupedKeys.length)
                }

                effectivePinnedList = effectivePinnedList.filter(p => norm(p) !== nsid)
                runningUnpinnedKeys = groupedKeys.filter(k => k !== nsid && k !== "home-shortcut" && !pinnedState.list.some(p => { const lid = norm(p); return appMatch(k, lid) }))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))

                const pinnedBoundary = 2 + effectivePinnedList.length

                if (previewIdx !== -1) {
                    if (previewIdx <= pinnedBoundary) {
                        let insertPos = previewIdx - 2
                        if (insertPos < 0) insertPos = 0
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
                runningUnpinnedKeys = groupedKeys.filter(k => k !== "home-shortcut" && !pinnedState.list.some(p => { const lid = norm(p); return appMatch(k, lid) }))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))
            }

            type ItemConfig = { id: string, width: number, syncData?: any, isPinned: boolean, factory: (vc: number) => Gtk.Widget, isSeparator?: boolean }
            const configs: ItemConfig[] = []
            const currentIds = new Set<string>()

            const getOrCreateItem = (id: string, factory: () => Gtk.Widget) => {
                currentIds.add(id)
                if (widgetCache.has(id)) return widgetCache.get(id)!
                const widget = factory()
                const revealer = new (Gtk as any).Revealer({
                    css_classes: ["cd-revealer"],
                    transition_type: isVertical
                        ? (dockSettings.position === 'left' ? Gtk.RevealerTransitionType.SLIDE_RIGHT : Gtk.RevealerTransitionType.SLIDE_LEFT)
                        : Gtk.RevealerTransitionType.SLIDE_UP,
                    transition_duration: 300,
                    child: widget,
                    reveal_child: firstRender
                })
                // VISIBLE overflow lets the slide-spring animate icons past the slot boundary
                // during reorder. The revealer still clips internally during its enter/exit
                // transition, so the SLIDE_UP entrance animation is unaffected.
                revealer.set_overflow(Gtk.Overflow.VISIBLE)
                // Pre-size vertical revealers to rest state so no layout jump on first tick.
                // Separators use SEPARATOR_SLOT; regular items use APP_SLOT.
                if (isVertical) {
                    const isSep = id.startsWith("sep-")
                    revealer.height_request = isSep ? DOCK_CONSTANTS.SEPARATOR_SLOT : DOCK_CONSTANTS.APP_SLOT
                    revealer.width_request  = DOCK_CONSTANTS.PILL_HEIGHT
                    revealer.overflow = Gtk.Overflow.VISIBLE
                    revealer.halign = Gtk.Align.FILL
                }
                if (!firstRender) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { revealer.reveal_child = true; return GLib.SOURCE_REMOVE })
                widgetCache.set(id, revealer)
                return revealer
            }

            if (firstRender) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { firstRender = false; return GLib.SOURCE_REMOVE })
            }

            widgetCache.forEach(w => {
                const inner = (w as any).get_child()
                if (inner && (inner as any).popdown) (inner as any).popdown()
            })

            // V620: Memoize heavy app lookups that run on every window focus change
            const appLookupCache = new Map<string, any>()

            // V149.3: UNIFIED APP SHIM 🛰️
            // Uses centered resolution from AppService for absolute truth.
            const findApp = (searchId: string) => appService.getResolvedApp(searchId)


            const userName = GLib.get_user_name()
            const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

            const homeItem = {
                name: prettyName,
                icon_name: ["finder", "system-file-manager", "user-home", "folder-home", "folder"],
                launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(e => {
                    // @ts-ignore
                    print(e)
                })
            }
            const homeAddrs = groupedClients["home-shortcut"]?.addresses || []
            configs.push({
                id: "home-shortcut", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: homeAddrs, clientTitle: undefined, appItem: homeItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "home-shortcut",
                        appItem: homeItem as any,
                        updateDock: update,
                        register: (id, s) => animRegistry.set(id, s),
                        addresses: homeAddrs,
                        clientTitle: undefined,
                        onPin, onUnpin, onReorder,
                        isPinned: true, // Special item logic handles actions
                        cleanId: "home-shortcut"
                    }, bar)

                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })
            // Fully consumed, remove from group mapping
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
                    const w = DockItem({
                        appId: "launcher",
                        appItem: launcherItem as any,
                        updateDock: update,
                        register: (id, s) => animRegistry.set(id, s),
                        addresses: [],
                        clientTitle: undefined,
                        onPin, onUnpin, onReorder,
                        isPinned: true,
                        cleanId: "launcher"
                    }, bar)

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
                    addrs = group.addresses
                    clientTitle = group.title
                    delete groupedClients[groupKey]
                    if (!appItem) {
                        appItem = {
                            name: clientTitle || group.displayClass,
                            icon_name: originalId || group.displayClass || lid,
                            launch: getLaunch(lid)
                        } as any
                    }
                    if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                        if (typeof appItem.icon_name === "string") {
                            appItem.icon_name = appItem.icon_name.replace(/-default$/i, "-Default");
                        }
                    }
                }

                if (appItem) {
                    if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                        // @ts-ignore
                        appItem.icon_name = originalId.replace(/-default$/i, "-Default")
                    }
                    // Crystal Shell internal windows use global toggles directly (no external process)
                    if (lid === "crystal-shell-settings") {
                        appItem.launch = () => { shellActions.toggleSettings?.() }
                    } else {
                        // Always use gtk-launch so PATH is fully resolved (needed for flatpak, etc.)
                        appItem.launch = getLaunch(lid)
                    }
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs, clientTitle, appItem: appItem! },
                        isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({
                                appId: lid,
                                appItem: appItem!,
                                updateDock: update,
                                register: (id, s) => animRegistry.set(id, s),
                                addresses: addrs,
                                clientTitle: clientTitle,
                                onPin, onUnpin, onReorder,
                                isPinned: true,
                                cleanId: lid
                            }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                } else {
                    const info = appService.getAppInfo(lid)
                    const displayName = info?.get_name() || lid
                    let icon = info?.get_id() || originalId
                    if (lid.startsWith("chrome-") && lid.endsWith("-default") && typeof icon === "string") {
                        icon = icon.replace(/-default$/i, "-Default")
                    }
                    const ghostLaunch = lid === "crystal-shell-settings"
                        ? () => { shellActions.toggleSettings?.() }
                        : getLaunch(lid)
                    const ghost = { name: displayName, icon_name: icon, launch: ghostLaunch } as any
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs: [], clientTitle: undefined, appItem: ghost },
                        isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({
                                appId: lid,
                                appItem: ghost,
                                updateDock: update,
                                register: (id, s) => animRegistry.set(id, s),
                                addresses: [],
                                clientTitle: undefined,
                                onPin, onUnpin, onReorder,
                                isPinned: true,
                                cleanId: lid
                            }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                }
            })

            if (runningUnpinnedKeys.length > 0) {
                const separatorId = "sep-running"
                configs.push({
                    id: separatorId, width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                    syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                    isPinned: true,
                    isSeparator: true,
                    factory: (vc) => {
                        const w = Separator(separatorId, update, (id, s) => animRegistry.set(id, s), onReorder)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            }

            runningUnpinnedKeys.forEach(k => {
                const group = groupedClients[k]
                const lid = k.toLowerCase().replace(".desktop", "")

                // Try mapped key first (handles remapped classes like crystal-shell-settings),
                // then fall back to original displayClass
                let appItem = findApp(lid) || findApp(group?.displayClass || "")
                if (!appItem) {
                    appItem = {
                        name: group?.title || group?.displayClass || k,
                        icon_name: lid,
                        launch: getLaunch(lid)
                    } as any
                }
                if (lid === "crystal-shell-settings") {
                    appItem.launch = () => { shellActions.toggleSettings?.() }
                }

                configs.push({
                    id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                    syncData: { addrs: group?.addresses || [], clientTitle: group?.title, appItem: appItem! },
                    isPinned: false,
                    factory: (vc) => {
                        const w = DockItem({
                            appId: lid,
                            appItem: appItem!,
                            updateDock: update,
                            register: (id, s) => animRegistry.set(id, s),
                            addresses: group?.addresses || [],
                            clientTitle: group?.title,
                            onPin, onUnpin, onReorder,
                            isPinned: false,
                            cleanId: lid
                        }, bar)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            })

            configs.push({
                id: "sep-trash", width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                isPinned: true,
                isSeparator: true,
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
                syncData: { addrs: [], clientTitle: undefined, appItem: trash as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "special:trash",
                        appItem: trash as any,
                        updateDock: update,
                        register: (id, s) => animRegistry.set(id, s),
                        addresses: [],
                        clientTitle: undefined,
                        onPin: () => { }, onUnpin: () => { }, onReorder: () => { }, // Special: No interactions
                        isPinned: true, // Special
                        cleanId: "special:trash"
                    }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            const processed = new Set<string>()
            const validConfigs = configs.filter(c => {
                if (processed.has(c.id)) return false
                processed.add(c.id); return true
            })

            // Capture current pixel positions BEFORE reordering so the slide spring can
            // animate each icon from its old visual position to the new one.
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

            totalStaticWidth = validConfigs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)

            // staticCenter is in dock-axis coords: X for bottom dock, Y for side docks.
            // Vertical: bar-relative (0 = bar top). valign=CENTER means the bar always centers
            // itself and we don't need axisStart — the cursor is adjusted in the motion handler.
            const axisSize = isVertical ? verticalUsableH : gdkmonitor.get_geometry().width
            const axisStart = isVertical ? 0 : Math.max(0, (axisSize - totalStaticWidth) / 2)
            let runningAxis = axisStart

            const finalItems = validConfigs.map((c) => {
                const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT
                const myCenter = runningAxis + (slotWidth / 2)
                runningAxis += slotWidth

                const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
                const state = animRegistry.get(c.id)
                if (state) state.staticCenter = myCenter

                const inner = (widget as any).get_child ? (widget as any).get_child() : widget
                if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)

                if (inner && (inner as any).syncState && (c as any).syncData) {
                    const d = (c as any).syncData
                        ; (inner as any).syncState(d.addrs, d.clientTitle, d.appItem, c.isPinned)
                }
                return widget
            })

            for (const [id, w] of widgetCache) {
                if (!currentIds.has(id)) {
                    widgetCache.delete(id)
                    animRegistry.delete(id)
                }
            }

            // Fire slide springs for items whose position changed in the new order.
            // Each item's icon is pre-displaced to its old visual position and springs to 0.
            let _slideAccNew = 0
            orderedIds.forEach(id => {
                const s = animRegistry.get(id)
                const newX = _slideAccNew
                _slideAccNew += s ? (s.currentWidth + s.currentMargin * 2) : DOCK_CONSTANTS.APP_SLOT
                if (!s || !_slideOldSet.has(id)) return
                const oldX = _slideOldPos.get(id)
                if (oldX === undefined) return
                const disp = oldX - newX
                if (Math.abs(disp) > 1) {
                    s.currentSlideX = (s.currentSlideX || 0) + disp
                    s.velocitySlideX = 0
                    s.targetSlideX = 0
                    if (!tickId) runUnifiedTick()
                }
            })

            // Surgical Reordering without destruction.
            // For items already in this bar we use reorder_child_after() instead of
            // unparent() + insert_child_after(). The unparent/reparent path temporarily
            // unmaps the Revealer widget, which resets its visual state and causes the
            // SLIDE_UP entrance animation to replay — producing the "dock rebuilds" flash
            // visible on every drop. reorder_child_after() moves the child in-place while
            // keeping it mapped, so no animation state is disturbed.
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

            // Remove lingering
            const finalSet = new Set(finalItems)
            let c = bar.get_first_child()
            while (c) {
                const next = c.get_next_sibling()
                if (!finalSet.has(c)) bar.remove(c)
                c = next
            }

            let totalCurrentWidth = 0
            const pX_sync = lastMousePos

            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return
                const metrics = calculateDockItemMetrics(pX_sync, state.staticCenter, state.isSeparator)
                state.targetScale = metrics.scale
                state.targetWidth = metrics.width
                state.targetHeight = metrics.height || DOCK_CONSTANTS.PILL_HEIGHT
                state.targetMargin = metrics.margin
                state.targetTranslateY = metrics.translateY

                // V603: Sync immediate state for first render OR when tick is not active
                // to prevent background width "lag/strips"
                if (firstRender || !tickId) {
                    state.currentScale = metrics.scale
                    state.currentWidth = metrics.width
                    state.currentMargin = metrics.margin

                    // Vertical: pre-apply the full at-rest slot layout so that the
                    // first tick frame finds every height/margin already correct
                    // and triggers no GTK layout reflow (prevents stretch-on-hover).
                    if (isVertical && !state.isSeparator) {
                        const edgeAlign = dockSettings.position === 'left' ? Gtk.Align.START : Gtk.Align.END
                        const widget = widgetCache.get(id)
                        if (widget) {
                            const slotH = Math.round(state.currentWidth + 2 * state.currentMargin)
                            const tps   = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)
                            const marginL = Math.floor((slotH - tps) / 2)
                            const marginR = Math.ceil((slotH - tps) / 2)
                            if ((widget as any).height_request !== slotH)
                                (widget as any).height_request = slotH
                            if ((widget as any).width_request !== DOCK_CONSTANTS.PILL_HEIGHT)
                                (widget as any).width_request = DOCK_CONSTANTS.PILL_HEIGHT
                            const itemBox = (widget as any).get_child ? (widget as any).get_child() : null
                            if (itemBox) {
                                if (itemBox.height_request !== tps)
                                    itemBox.height_request = tps
                                if (itemBox.margin_top !== marginL) itemBox.margin_top = marginL
                                if (itemBox.margin_bottom !== marginR) itemBox.margin_bottom = marginR
                                const overlay = itemBox.get_first_child ? itemBox.get_first_child() : null
                                if (overlay) {
                                    overlay.set_size_request(tps, tps)
                                    overlay.halign = edgeAlign
                                    const iconBox = overlay.get_child ? overlay.get_child() : null
                                    if (iconBox) {
                                        iconBox.set_size_request(tps, tps)
                                        iconBox.halign = edgeAlign
                                        iconBox.valign = Gtk.Align.CENTER
                                        ;(iconBox as any).margin_bottom = 0
                                    }
                                }
                            }
                        }
                    }
                }
                totalCurrentWidth += state.currentWidth + (state.currentMargin * 2)
            })

            // Sync alignment to prevent "bad load" shift.
            // Always snap for vertical to avoid one-frame lag where the pill is drawn too small
            // (icons appear squished). The snap uses currentWidth spring values, so it's correct
            // even during magnification animation.
            if (firstRender || !tickId || isVertical) {
                smoothedBarWidth = totalCurrentWidth
                if (!isVertical) {
                    const manualMarginStart = Math.round((dockMonitorWidth - smoothedBarWidth) / 2)
                    bar.margin_start = manualMarginStart
                    if (da) da.margin_start = manualMarginStart - DOCK_CONSTANTS.BASE_MARGIN
                }
                updateSize()
                firstRender = false
            }

            if (!tickId) runUnifiedTick()
            if (!skipTargets) updateAllTargets(lastMousePos, false)
            updateSize()
            // Re-assert exclusive zone after every widget-tree reconciliation.
            // Hyprland may briefly clear it when the layer surface commits a new buffer.
            if (layerShellReady && !isVertical && !dockSettings.autoHide) {
                Gtk4LayerShell.set_exclusive_zone(win, DOCK_CONSTANTS.EXCLUSIVE_ZONE)
            }
            return bar
        } catch (e) {
            console.error("[Dock] Update error:", e)
            return bar
        } finally {
            updateLock = false
            if (needsUpdate) {
                needsUpdate = false
                GLib.timeout_add(GLib.PRIORITY_LOW, 100, () => { update(); return GLib.SOURCE_REMOVE })
            }
        }
    }

    // dockMonitorWidth already declared at line 221
    win.set_default_size(WIN_W, WIN_H)
    let layerInit = false
    let layerShellReady = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) {
        console.warn("Gtk4LayerShell init failed (not on Wayland?): " + e)
    }
    win.set_size_request(WIN_W, WIN_H)
    win.set_decorated(false)

    try {
        // @ts-ignore
        win.app_paintable = true
        // @ts-ignore
        win.input_shape_combine_region(null)
    } catch (e) { }


    if (layerInit) {
        try {
            Gtk4LayerShell.set_namespace(win, "crystal-dock");
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP);
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND);

            if (isVertical) {
                Gtk4LayerShell.set_anchor(win, sideEdge, true);
                Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true);
                Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
                Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, BAR_HEIGHT);
            } else {
                Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
                Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true);
                Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true);
                Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 0);
            }
            if (orderedIds.length > 0) {
                let total = 0
                orderedIds.forEach(id => {
                    const s = animRegistry.get(id)
                    if (s) total += s.currentWidth + (s.currentMargin * 2)
                })
                updateInputRegion(total)
            }

            layerShellReady = true
            const exclusiveZone = (dockSettings.autoHide || isVertical) ? 0 : DOCK_CONSTANTS.EXCLUSIVE_ZONE
            Gtk4LayerShell.set_exclusive_zone(win, exclusiveZone)

            // Slide window to hidden position before first paint. Using set_margin on the
            // window avoids GTK widget negative-margin issues (same mechanism as vertical dock).
            if (dockSettings.autoHide) {
                if (isVertical) {
                    Gtk4LayerShell.set_margin(win, sideEdge, -(WIN_W - 4))
                } else {
                    Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, -Math.round(initialHideTarget))
                }
            }

            // Publish side width so CC/NC/Popups offset themselves
            if (isVertical) dockSideState.update(dockSettings.position, WIN_W)

            win.connect("realize", () => {
                if (orderedIds.length > 0) {
                    let total = 0
                    orderedIds.forEach(id => {
                        const s = animRegistry.get(id)
                        if (s) total += s.currentWidth + (s.currentMargin * 2)
                    })
                    updateInputRegion(total)
                } else {
                    updateInputRegion(totalStaticWidth)
                }
                // Defer clearing isSettlingIn so spurious Wayland pointer-enter events
                // (sent by the compositor when the new window appears under the cursor)
                // are still suppressed. realize fires synchronously inside win.present(),
                // before the compositor's events reach the GLib event loop.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    isSettlingIn = false
                    return GLib.SOURCE_REMOVE
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

    const cConn = hs.connect("changed", throttledUpdate)
    const aConn = appService.connect(throttledUpdate)

    // Recover immediately when any overlay closes — don't rely on the 100ms poll.
    const overlayRecovery = () => { if (!status.isAnyOverlayOpen && needsUpdate) throttledUpdate() }
    status.connect("notify::cc-open", overlayRecovery)
    status.connect("notify::nc-open", overlayRecovery)
    status.connect("notify::prism-open", overlayRecovery)
    status.connect("notify::system-menu-open", overlayRecovery)
    status.connect("notify::overview-open", overlayRecovery)


    // Emitted only on real drag-end (not clicks). Set isDndEnding for 700ms so the
    // leave handler and its callbacks skip setRevealed(false) while the drag cleanup
    // is still in progress (wl_pointer.leave can arrive before drag-end in the same frame).
    const pConn = pointerBus.onButtonReleased(() => {
        isDndEnding = true
        GLib.timeout_add(GLib.PRIORITY_HIGH, 700, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    })

    // When the context menu closes, de-magnify and start a hide timer (same as a leave
    // event). If the cursor is still inside the dock, the next motion/enter event cancels
    // the timer via clearLeaveTimeout() — no special cursor-position check needed.
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
                updateInputRegion(smoothedBarWidth)
                return GLib.SOURCE_REMOVE
            })
        }
    })

    const dConn = dragBus.subscribe((draggingId) => {
        if (draggingId) {
            // Drag START — lock the dock open for the entire drag.
            dndActive = true

            // V481: ABSOLUTE GRID ANCHOR
            const nsid = norm(draggingId)
            let virtualPinned = [...pinnedState.list]
            if (!virtualPinned.some(p => norm(p) === nsid)) {
                virtualPinned.push(draggingId)
            }
            lockedStaticWidth = calculateStableWidth(virtualPinned)

            const screenWidth = gdkmonitor.get_geometry().width
            lockedStartX = (screenWidth - lockedStaticWidth) / 2

            const currentIdx = pinnedState.list.findIndex(p => norm(p) === nsid)
            if (currentIdx !== -1) {
                previewIdx = currentIdx + 2
            } else {
                previewIdx = 2 + pinnedState.list.length
            }
            throttledUpdate()
        } else {
            // Drag END (GestureDrag released).
            // Commit the reorder if the cursor is still over the dock (previewIdx >= 0).
            // If the gesture ended outside the dock, just restore the original order.
            if (previewIdx >= 0 && lastDraggingId && lastMousePos >= 0) {
                onReorder(lastDraggingId)
            } else {
                // Dropped outside dock — restore without committing.
                previewIdx = -1
                isDndEnding = true
                update()
                GLib.timeout_add(GLib.PRIORITY_HIGH, 400, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
            }

            // Release the auto-hide lock slightly after gesture end.
            GLib.timeout_add(GLib.PRIORITY_HIGH, 200, () => {
                dndActive = false
                return GLib.SOURCE_REMOVE
            })

            // Safety cleanup after short delay.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (!dragBus.draggingId) {
                    lastDraggingId = ""
                    previewIdx = -1
                    if (lastMousePos < 0) updateAllTargets(-1000)
                    update()
                }
                return GLib.SOURCE_REMOVE
            })
        }
    })

    // In-place settings update — no dock rebuild needed for most settings.
    // position/autoHide require layer-shell reconfiguration and are handled by app.ts.
    const sConn = onDockSettingsChanged(() => {
        syncConstants()
        win.set_size_request(WIN_W, WIN_H)
        if (!isVertical) {
            da.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            shim.height_request = DOCK_CONSTANTS.PILL_HEIGHT
            // Re-sync window position so the dock stays at its correct hidden/visible
            // position after settings change (layer margin, not widget margin).
            if (layerShellReady) {
                Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, -Math.round(slideCurrent))
            }
        }
        if (layerShellReady && !isVertical && !dockSettings.autoHide) {
            Gtk4LayerShell.set_exclusive_zone(win, DOCK_CONSTANTS.EXCLUSIVE_ZONE)
        }
        update()
    })

    win.connect("destroy", () => {
        if (tickId) { bar.remove_tick_callback(tickId); tickId = null }
        if (updateTimer) { GLib.source_remove(updateTimer); updateTimer = null }
        try { if (cConn) hs.disconnect(cConn) } catch (e) { }
        try { if (aConn) aConn() } catch (e) { }
        try { if (pConn) pConn() } catch (e) { }
        try { if (dConn) dConn() } catch (e) { }
        try { if (sConn) sConn() } catch (e) { }
        try { if (mConn) mConn() } catch (e) { }
    })

    // Exposed for app.ts: elevate dock above fullscreen windows while launcher is open.
    // active=true  → OVERLAY layer + force reveal (autohide case)
    // active=false → TOP layer + re-hide if autohide and cursor is outside
    ;(win as any).setLauncherMode = (active: boolean) => {
        if (!layerShellReady) return
        if (active) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            // Force-reveal if autohide had it hidden
            if (dockSettings.autoHide && !isRevealed) {
                isRevealed = true
                slideTarget = 0
                runUnifiedTick(true)
            }
        } else {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            updateInputRegion(smoothedBarWidth)
            if (dockSettings.autoHide && !cursorInDock) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    if (!cursorInDock && menuState.openCount === 0) {
                        setRevealed(false)
                        updateInputRegion(smoothedBarWidth)
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
        clearLeaveTimeout()  // cancel any pending hide from a stale mouse-leave event
        appGridPanelOpen = true
        win.set_focusable(true)
        win.set_focus_visible(true)
        if (layerShellReady) {
            // OVERLAY ensures visibility above fullscreen windows; EXCLUSIVE routes all keys here
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
        }
        appGrid.widget.visible = true
        appGrid.onShow()
        // Full window receives input when appgrid is open
        const surface = win.get_native()?.get_surface()
        if (surface) surface.set_input_region(null)
        // Reveal dock if hidden (fullscreen mode or autohide)
        if (!isRevealed) {
            setRevealed(true)
            runUnifiedTick(true)
        }
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
            // Restore exclusive zone that was implicitly cleared while in OVERLAY
            if (!isVertical)
                Gtk4LayerShell.set_exclusive_zone(win, (isRevealed && !dockSettings.autoHide) ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0)
        }
        // Restore dock hide if in fullscreen or autohide with cursor outside
        if (fullscreenMode && !cursorInDock) {
            setRevealed(false)
        } else if (dockSettings.autoHide && !cursorInDock) {
            setRevealed(false)
        }
        updateInputRegion(smoothedBarWidth)
    }

    ;(win as any).toggleAppGridPanel = () => {
        if (appGridPanelOpen) closeAppGridPanel()
        else openAppGridPanel()
    }

    // BgClick: close appgrid when clicking outside squircle and outside dock strip
    const bgClickGesture = new Gtk.GestureClick()
    bgClickGesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
    bgClickGesture.connect("released", (_gesture: any, _n: number, x: number, y: number) => {
        if (!appGridPanelOpen) return
        const a = appGrid.widget.get_allocation()
        const inSquircle  = x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height
        const inDockStrip = y >= WIN_H - DOCK_CONSTANTS.PILL_HEIGHT * 1.5
        if (!inSquircle && !inDockStrip) closeAppGridPanel()
    })
    windowOverlay.add_controller(bgClickGesture)

    // Key handler: delegate to appgrid when open
    const appGridKeyCtrl = new Gtk.EventControllerKey()
    appGridKeyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    appGridKeyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
        if (!appGridPanelOpen) return false
        return appGrid.handleKey(keyval)
    })
    win.add_controller(appGridKeyCtrl)

    // ── Fullscreen detection ──────────────────────────────────────────────────
    // When a fullscreen window is focused, force-hide the dock and disable the
    // cursor trigger strip. The dock re-appears only when:
    //   a) the appgrid opens (Super key), or
    //   b) the fullscreen window loses focus / exits fullscreen.
    let fullscreenMode = false
    let trackedClient: any = null
    let trackedClientConn: number | null = null

    const setFullscreenMode = (active: boolean) => {
        if (fullscreenMode === active) return
        fullscreenMode = active
        if (active && !appGridPanelOpen) {
            if (isRevealed) setRevealed(false)
            updateInputRegion(smoothedBarWidth)
        } else if (!active) {
            if (!dockSettings.autoHide || cursorInDock) {
                setRevealed(true)
                runUnifiedTick(true)
            }
            updateInputRegion(smoothedBarWidth)
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
    // V197: Redundant late-update timeouts removed. initialPinned logic handles it.

    win.present()

    // V401: Late Focus Clear (The "Ghost" Fix)
    // Run after window manager has successfully mapped and focused the window
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        win.set_focus_visible(false)
        win.set_focus(null)
        return GLib.SOURCE_REMOVE
    })

    return win
}
