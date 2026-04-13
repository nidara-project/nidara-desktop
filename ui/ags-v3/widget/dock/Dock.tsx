import app from "ags/gtk4/app"
import { Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import { calculateDockItemMetrics, DOCK_CONSTANTS, springStep } from "./DockPhysics"
import type { SpringChannel } from "./DockPhysics"
import appService from "../../core/AppService"
import { DockItem, Separator } from "./DockItem"
import { drawSquircle } from "../common/DrawingUtils"
import { hypr, appsService as apps, dragBus, mouseBus, savePinned, pinnedState, dockSettings, menuState, dockSideState } from "./state"
import status from "../../core/Status"
import Theme from "core/ThemeManager"

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

    // V475: Synchronous Width Helper
    // This allows updateAllTargets and update to always see the same base width
    // regardless of when they are called.
    const calculateStableWidth = (effectivePinned: string[]) => {
        const groupedClients: { [key: string]: any } = {}
        hypr.clients.forEach(c => {
            if (c.class?.toLowerCase().includes("ags")) return
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

        // Total = Launcher(1) + Home(1) + Pinned + Running + Trash(1) + Separators(2)
        const apps = 3 + effectivePinned.length + runningUnpinnedCount
        return (apps * DOCK_CONSTANTS.APP_SLOT) + (2 * DOCK_CONSTANTS.SEPARATOR_SLOT)
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
            const relX = lastMouseX - lockedStartX
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
        }

        // V496: ATOMIC RESET. Force animation reset immediately.
        previewIdx = -1
        lastDraggingId = ""
        dragBus.setDragging("")
        updateAllTargets(-1000)
        update()
    }


    const dockMonitorWidth = gdkmonitor.get_geometry().width
    const dockMonitorHeight = gdkmonitor.get_geometry().height
    // For vertical: window spans available height (excluding top bar)
    const verticalUsableH = dockMonitorHeight - BAR_HEIGHT
    // For vertical: window is pill-wide; for horizontal: full-screen-wide
    const WIN_W = isVertical ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : dockMonitorWidth
    const WIN_H = isVertical ? verticalUsableH : DOCK_CONSTANTS.WINDOW_HEIGHT
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
    win.set_child(layout)
    const bar = new Gtk.Box({
        name: "cd-bar",
        css_classes: ["cd-bar"],
        spacing: 0,
        orientation: isVertical ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL,
        halign: isVertical ? Gtk.Align.CENTER : Gtk.Align.START,
        valign: isVertical ? Gtk.Align.START  : Gtk.Align.END,
        hexpand: false,
        vexpand: false,
    })

    const da = new Gtk.DrawingArea({
        name: "dock-gloss-layer",
        valign: isVertical ? Gtk.Align.FILL : Gtk.Align.END,
        halign: isVertical ? Gtk.Align.FILL : Gtk.Align.START,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        margin_bottom: isVertical ? 0 : dockSettings.screenGap,
        can_focus: false,
    })

    da.set_draw_func((_, cr, w, h) => {
        if (isVertical) {
            // Draw pill at the correct side and centered vertically within the full window
            const pw = DOCK_CONSTANTS.PILL_HEIGHT
            const ph = smoothedBarWidth + DOCK_CONSTANTS.BASE_MARGIN * 2
            const px = dockSettings.position === 'right' ? 0 : dockSettings.screenGap
            const py = Math.max(0, Math.round((h - ph) / 2))
            cr.translate(px, py)
            drawSquircle(cr, pw, ph, undefined, 0.15, true, undefined, undefined, false, undefined, 3.2, 1.0, 0)
        } else {
            drawSquircle(cr, w, h, undefined, 0.15, true, undefined, undefined, false, undefined, 3.2, 1.0, 0)
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
            // smoothedBarWidth accumulates total HEIGHT in vertical mode
            bar.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, smoothedBarWidth)
            const targetH = smoothedBarWidth + (DOCK_CONSTANTS.BASE_MARGIN * 2)
            if (da) { da.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, targetH); da.queue_draw() }
        } else {
            bar.set_size_request(smoothedBarWidth, -1)
            const targetW = smoothedBarWidth + (DOCK_CONSTANTS.BASE_MARGIN * 2)
            if (da) { da.set_size_request(targetW, DOCK_CONSTANTS.PILL_HEIGHT); da.queue_draw() }
        }
    }

    // Pre-emptive centering (horizontal) / top margin (vertical)
    const initialMargin = Math.round((dockMonitorWidth - totalStaticWidth) / 2)
    if (!isVertical) {
        bar.margin_start = Math.max(0, initialMargin)
        if (da) da.margin_start = Math.max(0, initialMargin - DOCK_CONSTANTS.BASE_MARGIN)
    } else {
        // Set initial vertical centering immediately so the first frame is correct
        bar.margin_top = Math.max(0, Math.round((verticalUsableH - totalStaticWidth) / 2))
    }

    // --- PHYSICS ENGINE ---
    const animRegistry = new Map<string, import("./state").AnimState>()

    let lastFrameTime = 0
    let tickId: number | null = null

    // ── Auto-hide slide state ─────────────────────────────────────────────────
    // slideOffset: 0 = fully visible, PILL_HEIGHT+screenGap = fully hidden below screen
    let slideTarget = 0
    let slideCurrent = 0
    let slideVelocity = 0
    let isRevealed = true
    const SLIDE_STIFFNESS = 500
    const SLIDE_DAMPING = 52

    const setRevealed = (reveal: boolean) => {
        if (isRevealed === reveal) return
        isRevealed = reveal
        slideTarget = reveal ? 0 : (isVertical
            ? WIN_W - 4   // leave 4px on-screen as the hover trigger strip
            : DOCK_CONSTANTS.PILL_HEIGHT + dockSettings.screenGap + 4)
        if (layerShellReady) {
            const zone = reveal ? (isVertical ? WIN_W : DOCK_CONSTANTS.EXCLUSIVE_ZONE) : 0
            Gtk4LayerShell.set_exclusive_zone(win, zone)
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

            const dt = 1 / 60 // Fixed time step for stability
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

                if (a1 || a2 || a3) active = true
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
                        if (revealer.height_request !== slotW) revealer.height_request = slotW
                        if (revealer.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) revealer.width_request = DOCK_CONSTANTS.PILL_HEIGHT
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
                        // Vertical: slot height = slotW, full pill width
                        if (revealer.height_request !== slotW) revealer.height_request = slotW
                        if (revealer.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) revealer.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                        if (itemBox) {
                            // Fill full pill width so indicator and icon position correctly
                            itemBox.halign = Gtk.Align.FILL
                            itemBox.valign = Gtk.Align.START
                            if (itemBox.width_request !== DOCK_CONSTANTS.PILL_HEIGHT) itemBox.width_request = DOCK_CONSTANTS.PILL_HEIGHT
                            if (itemBox.height_request !== tps) itemBox.height_request = tps
                            if (itemBox.margin_top !== marginL) itemBox.margin_top = marginL
                            if (itemBox.margin_bottom !== marginR) itemBox.margin_bottom = marginR
                            itemBox.margin_start = 0; itemBox.margin_end = 0
                        }
                    } else {
                        if (revealer.width_request !== slotW) revealer.width_request = slotW
                        if (itemBox) {
                            if (itemBox.width_request !== tps) itemBox.width_request = tps
                            if (itemBox.margin_start !== marginL) itemBox.margin_start = marginL
                            if (itemBox.margin_end !== marginR) itemBox.margin_end = marginR
                            itemBox.margin_bottom = Math.round(0 - (state.currentTranslateY || 0))
                        }
                    }

                    // Visual nested sizing
                    const overlay = itemBox?.get_first_child() as Gtk.Overlay
                    if (overlay) {
                        if (isVertical) {
                            // Force overlay to fill the full pill width so icon+indicator position correctly
                            overlay.set_size_request(DOCK_CONSTANTS.PILL_HEIGHT, tps)
                            overlay.halign = Gtk.Align.FILL
                        }
                        const iconBox = overlay.get_child() as Gtk.Box
                        if (iconBox) {
                            iconBox.set_size_request(tps, tps)
                            if (isVertical) {
                                // Icon centered within full pill width
                                iconBox.halign = Gtk.Align.CENTER
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

            // Step 3: Bar position (horizontal: margin_start; vertical: margin_top)
            const roundedTotalWidth = Math.round(totalBarWidth)

            if (isVertical) {
                // totalBarWidth = total height of all icon slots
                const barM = Math.round((verticalUsableH - roundedTotalWidth) / 2)
                if (bar.margin_top !== barM) bar.margin_top = barM
            } else {
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
                    const mb = dockSettings.screenGap - offset
                    if (shim.margin_bottom !== mb) shim.margin_bottom = mb
                    if (da.margin_bottom !== mb) da.margin_bottom = mb
                }
                active = true
            } else if (slideCurrent !== slideTarget) {
                slideCurrent = slideTarget
                slideVelocity = 0
                if (isVertical) {
                    if (layerShellReady) Gtk4LayerShell.set_margin(win, sideEdge, -Math.round(slideTarget))
                } else {
                    const mb = dockSettings.screenGap - Math.round(slideTarget)
                    shim.margin_bottom = mb
                    da.margin_bottom = mb
                }
            }

            if (!active) {
                tickId = null; lastFrameTime = 0
                return false
            }
            return true
        })
        if (seedFrame && da) da.queue_draw()
    }

    let lastMouseX = -1000
    const updateAllTargets = (mouseX: number, seedFrame = true) => {
        // V320: Freeze magnification shifts while a menu is open to prevent "ghost menu" flickering
        if (menuState.openCount > 0) return

        const screenWidth = gdkmonitor.get_geometry().width
        lastMouseX = mouseX

        // Static centers are in screen coordinates, so pass mouseX directly.
        // NO projection feedback loop — eliminates the vibration bug.
        const pX = lastMouseX

        const draggingId = dragBus.draggingId
        if (draggingId) {
            // V480: STATIC LOGIC ANCHOR
            // We use the startX captured when the drag began for the GRID.
            // This makes slot calculation absolute and immune to visual shifts.
            const relX = lastMouseX - lockedStartX

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
    motion.connect("enter", () => { })
    const updateInputRegion = (totalWidth: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

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
                // Visible: only the pill column (prevents transparent gaps from blocking clicks)
                const pillX = dockSettings.position === 'left' ? dockSettings.screenGap : 0
                // @ts-ignore
                region.unionRectangle({ x: pillX, y: 0, width: DOCK_CONSTANTS.PILL_HEIGHT, height: WIN_H })
            }
            surface.set_input_region(region)
            return
        }

        // When auto-hide is on and dock is hidden, expose only a thin strip at
        // the very bottom of the window (= screen edge) so the mouse can trigger reveal.
        if (dockSettings.autoHide && !isRevealed && slideTarget > 0) {
            // @ts-ignore
            region.unionRectangle({ x: 0, y: DOCK_CONSTANTS.WINDOW_HEIGHT - 4, width: dockMonitorWidth, height: 4 })
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
        const y = DOCK_CONSTANTS.WINDOW_HEIGHT - DOCK_CONSTANTS.PILL_HEIGHT

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
        clearLeaveTimeout()

        // Auto-hide: reveal dock on any mouse entry
        if (dockSettings.autoHide && !isRevealed) {
            setRevealed(true)
            updateInputRegion(smoothedBarWidth)
        }

        // Vertical dock: no magnification
        if (isVertical) {
            updateAllTargets(-1000)
            return
        }

        if (dragBus.draggingId) {
            updateAllTargets(x)
            return
        }

        const yLimit = DOCK_CONSTANTS.WINDOW_HEIGHT - DOCK_CONSTANTS.PILL_HEIGHT
        if (y < yLimit) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        if (dragBus.draggingId) return

        clearLeaveTimeout()
        const magnDelay = 50
        const hideDelay = dockSettings.autoHide ? Math.max(magnDelay, dockSettings.hideDelay) : magnDelay
        leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideDelay, () => {
            updateAllTargets(-1000)
            if (dockSettings.autoHide) {
                setRevealed(false)
                updateInputRegion(smoothedBarWidth)
            }
            leaveTimeout = null
            return GLib.SOURCE_REMOVE
        })
    })

    const shim = new Gtk.Box({
        valign: isVertical ? Gtk.Align.START : Gtk.Align.END,
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

    // V470: GLOBAL DROP TARGET
    // This catches drops even in the gaps between icons, using previewIdx    // V470: GLOBAL DROP TARGET
    const barDropTarget = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE, formats: null })
    barDropTarget.set_gtypes([GObject.TYPE_STRING])

    // V530: SIGNAL TUNNELING ATTACHMENT
    // We subscribe to mouseBus to ensure that motion signals from icons OR the background
    // ALWAYS drive the magnification and reordering logic.
    const mSub = mouseBus.subscribe((x) => updateAllTargets(x))

    barDropTarget.connect("motion", (t, x, y) => {
        // V478: Signal Tunneling
        // Connect motion to mouseBus to drive animations during drag
        mouseBus.emit(x) // Since DropTarget is on layout, x is already window-relative
        return Gdk.DragAction.MOVE
    })

    barDropTarget.connect("drop", (t, val) => {
        const draggingId = dragBus.draggingId || (val as string)
        if (!draggingId) return false

        console.log(`[Dock] Global Drop triggered for ${draggingId}`)
        onReorder(draggingId)
        return true
    })
    // V471: Move Global DropTarget to the layout overlay ONLY
    layout.add_controller(barDropTarget)

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

            const draggingId = dragBus.draggingId
            const hoverId = dragBus.hoverId

            // V515: DUAL-ZONE LOGIC
            let effectivePinnedList = [...pinnedState.list]
            let runningUnpinnedKeys: string[] = []

            const groupedKeys = Object.keys(groupedClients)
            const nsid = draggingId ? norm(draggingId) : ""

            if (draggingId) {
                if (draggingId !== lastDraggingId) {
                    lastDraggingId = draggingId
                    const currentPos = pinnedState.list.findIndex(p => norm(p) === nsid)
                    previewIdx = currentPos !== -1 ? currentPos + 2 : (2 + pinnedState.list.length + groupedKeys.length)
                }

                effectivePinnedList = effectivePinnedList.filter(p => norm(p) !== nsid)
                runningUnpinnedKeys = groupedKeys.filter(k => k !== nsid && k !== "home-shortcut" && !pinnedState.list.some(p => norm(p) === k))

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
                runningUnpinnedKeys = groupedKeys.filter(k => k !== "home-shortcut" && !pinnedState.list.some(p => norm(p) === k))
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
                    transition_type: isVertical ? Gtk.RevealerTransitionType.SLIDE_DOWN : Gtk.RevealerTransitionType.SLIDE_LEFT,
                    transition_duration: 300,
                    child: widget,
                    reveal_child: firstRender
                })
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
                name: "Lanzador",
                icon_name: ["view-app-grid-symbolic", "view-app-grid", "org.gnome.Shell.Apps-symbolic", "pan-start-symbolic"],
                launch: () => { if ((globalThis as any).toggleAppGrid) (globalThis as any).toggleAppGrid() }
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
                const groupKey = Object.keys(groupedClients).find(k =>
                    k === targetKey || k.includes(targetKey) || targetKey.includes(k)
                )
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
                        appItem.launch = () => { (globalThis as any).toggleSettings?.() }
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
                        ? () => { (globalThis as any).toggleSettings?.() }
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
                    appItem.launch = () => { (globalThis as any).toggleSettings?.() }
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
                name: "Papelera",
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

            orderedIds = validConfigs.map(c => c.id)
            currentTotalItems = validConfigs.length

            totalStaticWidth = validConfigs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)

            const screenWidth = gdkmonitor.get_geometry().width
            const startX = (screenWidth - totalStaticWidth) / 2
            let runningX = startX

            const finalItems = validConfigs.map((c) => {
                const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT
                const myCenter = runningX + (slotWidth / 2)
                runningX += slotWidth

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

            // Surgical Reordering without destruction
            let currentChild = bar.get_first_child()
            let prevSibling: Gtk.Widget | null = null
            finalItems.forEach(item => {
                if (currentChild !== item) {
                    if (item.get_parent()) item.unparent()
                    bar.insert_child_after(item, prevSibling)
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
            const pX_sync = lastMouseX

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
                }
                totalCurrentWidth += state.currentWidth + (state.currentMargin * 2)
            })

            // Sync alignment to prevent "bad load" shift
            if (firstRender || !tickId) {
                smoothedBarWidth = totalCurrentWidth
                if (isVertical) {
                    bar.margin_top = Math.max(0, Math.round((verticalUsableH - smoothedBarWidth) / 2))
                } else {
                    const manualMarginStart = Math.round((dockMonitorWidth - smoothedBarWidth) / 2)
                    bar.margin_start = manualMarginStart
                    if (da) da.margin_start = manualMarginStart - DOCK_CONSTANTS.BASE_MARGIN
                }
                updateSize()
                firstRender = false
            }

            if (!tickId) runUnifiedTick()
            if (!skipTargets) updateAllTargets(lastMouseX, false)
            updateSize()
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
            // Vertical dock: exclusive_zone = 0. Layer-shell exclusive zones on LEFT/RIGHT
            // also push other surfaces anchored to those edges (including the bar).
            // No clean protocol-level solution exists for reserving side space without
            // affecting the bar. Auto-hide is the recommended mode for vertical positions.
            const exclusiveZone = (dockSettings.autoHide || isVertical) ? 0 : DOCK_CONSTANTS.EXCLUSIVE_ZONE
            Gtk4LayerShell.set_exclusive_zone(win, exclusiveZone)

            // Publish side width so CC/NC/Popups offset themselves
            if (isVertical) dockSideState.update(dockSettings.position, WIN_W)

            win.connect("realize", () => {
                // V300: Delegate to surgical updateInputRegion on realize
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

    const cConn = hypr.connect("notify::clients", throttledUpdate)
    const fConn = hypr.connect("notify::focused-client", throttledUpdate)
    const aConn = appService.connect(throttledUpdate)

    // Recover immediately when any overlay closes — don't rely on the 100ms poll.
    const overlayRecovery = () => { if (!status.isAnyOverlayOpen && needsUpdate) throttledUpdate() }
    status.connect("notify::cc-open", overlayRecovery)
    status.connect("notify::nc-open", overlayRecovery)
    status.connect("notify::prism-open", overlayRecovery)
    status.connect("notify::system-menu-open", overlayRecovery)
    status.connect("notify::overview-open", overlayRecovery)


    const dConn = dragBus.subscribe((draggingId) => {
        // V461: Reset reordering state when a drag starts/ends
        if (draggingId) {
            // V481: ABSOLUTE GRID ANCHOR
            // We calculate the width the dock WILL have once it grows for the dragging item.
            const nsid = norm(draggingId)
            let virtualPinned = [...pinnedState.list]
            if (!virtualPinned.some(p => norm(p) === nsid)) {
                virtualPinned.push(draggingId)
            }
            lockedStaticWidth = calculateStableWidth(virtualPinned)

            // The grid is centered on the monitor. 
            // lockedStartX is the unmagnified start position of this centered grid.
            const screenWidth = gdkmonitor.get_geometry().width
            lockedStartX = (screenWidth - lockedStaticWidth) / 2

            const currentIdx = pinnedState.list.findIndex(p => norm(p) === nsid)
            if (currentIdx !== -1) {
                // V520: Offset by 2 for Launcher and Home
                previewIdx = currentIdx + 2
            } else {
                // Start at the end of pinned list (Zone boundary)
                previewIdx = 2 + pinnedState.list.length
            }
        } else {
            // V486: Clean reset after a short grace period
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (!dragBus.draggingId) {
                    lastDraggingId = ""
                    previewIdx = -1
                    // V497: Final safety reset to clear any stuck magnification
                    updateAllTargets(-1000)
                }
                return GLib.SOURCE_REMOVE
            })
        }
        throttledUpdate()
    })

    win.connect("destroy", () => {
        if (tickId) { bar.remove_tick_callback(tickId); tickId = null }
        if (updateTimer) { GLib.source_remove(updateTimer); updateTimer = null }
        try { if (cConn) GObject.signal_handler_disconnect(hypr, cConn) } catch (e) { }
        try { if (fConn) GObject.signal_handler_disconnect(hypr, fConn) } catch (e) { }
        try { if (aConn) aConn() } catch (e) { }
        try { if (dConn) dConn() } catch (e) { }
        try { if (mSub) mSub() } catch (e) { }
    })

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
