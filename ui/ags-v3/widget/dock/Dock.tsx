import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import GdkPixbuf from "gi://GdkPixbuf"
import { calculateDockItemMetrics, DOCK_CONSTANTS, getProjectedMouseX } from "./DockPhysics"
import appService from "../../core/AppService"
import { DockItem, Separator } from "./DockItem"
import { drawSquircle } from "./DockUtils"
import { hypr, appsService as apps, dragBus, mouseBus, savePinned, pinnedState } from "./state"

console.log("[Dock] Module Loaded")
// @ts-ignore
print("[Dock] Module Loaded (print)")

// BFS/DFS Traversal for Deep Debugging
function traverse(widget: any, depth = 0) {
    if (!widget) return ""
    let indent = "  ".repeat(depth)

    let name = widget.get_name ? widget.get_name() : "unnamed"
    let classes = (widget.get_css_classes?.() || []).join(".")
    let flagsStr = ""

    try {
        const state = widget.get_state_flags()
        const f: string[] = []
        if (state & Gtk.StateFlags.PRELIGHT) f.push("HOVER")
        if (state & Gtk.StateFlags.FOCUSED) f.push("FOCUSED")
        if (state & Gtk.StateFlags.FOCUS_WITHIN) f.push("FOCUS_WITHIN")
        if (state & Gtk.StateFlags.ACTIVE) f.push("ACTIVE")
        if (state & Gtk.StateFlags.CHECKED) f.push("CHECKED")
        if (state & Gtk.StateFlags.SELECTED) f.push("SELECTED")
        if (f.length > 0) flagsStr = ` [${f.join(" ")}]`
    } catch (e) { }

    let out = `${indent}<${widget.constructor.name || 'Widget'} name="${name}" class="${classes}"${flagsStr}>\n`

    let child = widget.get_first_child?.()
    while (child) {
        out += traverse(child, depth + 1)
        child = child.get_next_sibling?.()
    }
    return out
}

function debugLauncherState(widget: Gtk.Widget) {
    if (!widget) return
    const dump = () => {
        try {
            const tree = traverse(widget)
            // @ts-ignore
            print(`[StateDebug Dump] \n${tree}`)
        } catch (e) {
            // @ts-ignore
            print(e)
        }
        return GLib.SOURCE_CONTINUE
    }
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, dump) // Slower interval, full dump
}

// V127: Native Gtk Resolution - No mapping needed

// --- PERSISTENCE Moved to state.ts ---

// --- MOUSE BUS FOR MAGNIFICATION Moved to shared state ---


export default function Dock(gdkmonitor: any) {
    // V180: Sync initial width with pinned items to prevent "One-Time Jump" on startup
    const norm = (s: string) => (s || "").toLowerCase().replace(".desktop", "")

    // V475: Synchronous Width Helper
    // This allows updateAllTargets and update to always see the same base width
    // regardless of when they are called.
    const calculateStableWidth = (effectivePinned: string[]) => {
        const groupedClients: { [key: string]: any } = {}
        hypr.clients.forEach(c => {
            if (c.class?.toLowerCase().includes("ags")) return
            groupedClients[c.class.toLowerCase()] = true
        })
        const runningUnpinnedCount = Object.keys(groupedClients).filter(c =>
            !effectivePinned.some(p => norm(p) === c)
        ).length

        // Total = Launcher(1) + Home(1) + Pinned + Running + Trash(1) + Separators(2)
        const apps = 3 + effectivePinned.length + runningUnpinnedCount
        return (apps * DOCK_CONSTANTS.APP_SLOT) + (2 * DOCK_CONSTANTS.SEPARATOR_SLOT)
    }

    const initialPinned = [...pinnedState.list]
    let totalStaticWidth = calculateStableWidth(initialPinned)
    const widgetCache = new Map<string, Gtk.Widget>()
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
        halign: Gtk.Align.FILL, // V609: Allow manual centering
        valign: Gtk.Align.END,
    })

    let previewIdx = -1
    let lastDraggingId = ""
    let lockedStaticWidth = 0
    let lockedStartX = 0

    const getLaunch = (lid: string) => {
        const app = appService.getAppData(lid)
        const desktopId = app?.id || lid
        return () => execAsync(`gtk-launch ${desktopId}`).catch(print)
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


    const win = new Gtk.Window({
        name: "crystal-dock",
        css_classes: ["crystal-dock-window"],
        application: app,
        focusable: false,
        can_focus: false,
        can_target: true,
        resizable: false,
        default_height: 120, // Reverted per user request
    })
    win.set_child(layout)
    const bar = new Gtk.Box({
        name: "cd-bar",
        css_classes: ["cd-bar"],
        spacing: 0,
        halign: Gtk.Align.START,
        valign: Gtk.Align.END,
        hexpand: false,
    })

    const dockMonitorWidth = gdkmonitor.get_geometry().width

    const da = new Gtk.DrawingArea({
        name: "dock-gloss-layer",
        valign: Gtk.Align.END,
        halign: Gtk.Align.START, // V615: Unified START anchor
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        margin_bottom: 10,
        can_focus: false,
    })

    da.set_draw_func((_, cr, w, h) => {
        // V430: Enable Gloss/Border effect for main dock
        drawSquircle(cr, w, h, undefined, 0.2, true)
    })

    const updateSize = () => {
        if (!bar || !win) return
        bar.set_size_request(smoothedBarWidth, -1)
        const targetW = smoothedBarWidth + 18
        if (da) {
            da.set_size_request(targetW, DOCK_CONSTANTS.PILL_HEIGHT)
            da.queue_draw()
        }
    }

    // V615: PRE-EMPTIVE CENTERING
    // Set the margin immediately so the very first frame is correct.
    const initialMargin = Math.round((dockMonitorWidth - totalStaticWidth) / 2)
    bar.margin_start = Math.max(0, initialMargin)
    if (da) da.margin_start = Math.max(0, initialMargin - 9) // V616: Center background pill

    // --- V17 PHYSICS ENGINE ---
    // AnimState imported from ./state
    const animRegistry = new Map<string, import("./state").AnimState>()

    let lastFrameTime = 0
    let tickId: number | null = null

    const runUnifiedTick = () => {
        if (tickId !== null) return

        const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor

        tickId = bar.add_tick_callback((_, clock) => {
            if ((globalThis as any).isAnyMenuOpen) return true

            let active = false
            let currentFloatX = 0
            // dockMonitorWidth already declared at top

            if (orderedIds.length === 0) {
                tickId = null
                return false
            }

            const stiffness = DOCK_CONSTANTS.STIFFNESS
            const damping = DOCK_CONSTANTS.DAMPING
            const dt = 1 / 60 // Fixed time step for stability

            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                // SPRING SCALE
                const forceScale = stiffness * (state.targetScale - state.currentScale) - damping * state.velocityScale
                state.velocityScale += forceScale * dt
                state.currentScale += state.velocityScale * dt
                if (Math.abs(state.targetScale - state.currentScale) < 0.001 && Math.abs(state.velocityScale) < 0.01) {
                    state.currentScale = state.targetScale
                    state.velocityScale = 0
                }

                // SPRING WIDTH
                const forceWidth = stiffness * (state.targetWidth - state.currentWidth) - damping * state.velocityWidth
                state.velocityWidth += forceWidth * dt
                state.currentWidth += state.velocityWidth * dt
                if (Math.abs(state.targetWidth - state.currentWidth) < 0.01 && Math.abs(state.velocityWidth) < 0.1) {
                    state.currentWidth = state.targetWidth
                    state.velocityWidth = 0
                }

                // SPRING MARGIN
                const forceMargin = stiffness * (state.targetMargin - state.currentMargin) - damping * state.velocityMargin
                state.velocityMargin += forceMargin * dt
                state.currentMargin += state.velocityMargin * dt
                if (Math.abs(state.targetMargin - state.currentMargin) < 0.01 && Math.abs(state.velocityMargin) < 0.1) {
                    state.currentMargin = state.targetMargin
                    state.velocityMargin = 0
                }

                // Check Activity
                if (state.currentScale !== state.targetScale ||
                    state.currentWidth !== state.targetWidth ||
                    state.currentMargin !== state.targetMargin) {
                    active = true
                }

                const floatSlotW = state.currentWidth + (state.currentMargin * 2)
                const floatIconStart = currentFloatX + state.currentMargin
                const floatIconEnd = floatIconStart + state.currentWidth
                const floatSlotEnd = currentFloatX + floatSlotW

                const intSlotStart = Math.round(currentFloatX)
                const intSlotEnd = Math.round(floatSlotEnd)
                const intIconStart = Math.round(floatIconStart)
                const intIconEnd = Math.round(floatIconEnd)

                currentFloatX = floatSlotEnd

                const widget = state.widget || widgetCache.get(id)
                if (widget) {
                    const revealer = widget as any
                    const itemBox = revealer.get_child ? (revealer.get_child() as Gtk.Box) : revealer

                    const drawSlotW = intSlotEnd - intSlotStart
                    const drawIconW = intIconEnd - intIconStart
                    const drawMarginS = intIconStart - intSlotStart
                    const drawMarginE = drawSlotW - (drawIconW + drawMarginS)

                    if (revealer.width_request !== drawSlotW) {
                        revealer.width_request = drawSlotW
                        if (itemBox) itemBox.width_request = drawIconW
                    }

                    if (itemBox) {
                        const subpixelShift = (currentFloatX + (floatSlotW / 2)) - (intSlotStart + (drawSlotW / 2))
                        const scale = state.currentScale
                        itemBox.set_style(`transform: translateX(${subpixelShift.toFixed(3)}px);`)

                        itemBox.margin_bottom = Math.round(0 - (state.currentTranslateY || 0))
                        if (itemBox.margin_start !== drawMarginS || itemBox.margin_end !== drawMarginE) {
                            itemBox.margin_start = drawMarginS
                            itemBox.margin_end = drawMarginE
                        }
                    }

                    if (state.isSeparator) {
                        const centerBox = itemBox as Gtk.CenterBox
                        const line = centerBox?.get_center_widget() as Gtk.Box
                        if (line) line.set_size_request(-1, Math.round(state.currentHeight))
                    } else if (!state.isSeparator) {
                        const targetPixelSize = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)
                        const overlay = itemBox?.get_first_child() as Gtk.Overlay
                        if (overlay) {
                            const iconBox = overlay.get_child() as Gtk.Box
                            if (iconBox) {
                                iconBox.set_size_request(drawIconW, targetPixelSize)
                                const plateOverlay = iconBox.get_first_child() as Gtk.Overlay
                                if (plateOverlay && plateOverlay.get_child) {
                                    const da = plateOverlay.get_child()
                                    if (da) {
                                        da.set_size_request(drawIconW, targetPixelSize)
                                        const icon = (da as any).get_next_sibling()
                                        if (icon) icon.set_size_request(targetPixelSize, targetPixelSize)
                                    }
                                } else {
                                    const icon = iconBox.get_first_child()
                                    if (icon) icon.set_size_request(targetPixelSize, targetPixelSize)
                                }
                            }
                        }
                    }
                }
            })

            const totalFloatWidth = currentFloatX
            const totalIntWidth = Math.round(totalFloatWidth)
            const floatMarginStart = (dockMonitorWidth - totalFloatWidth) / 2
            const intMarginStart = Math.round(floatMarginStart)
            const marginShift = floatMarginStart - intMarginStart

            if (bar.margin_start !== intMarginStart) {
                bar.margin_start = intMarginStart
                if (da) da.margin_start = intMarginStart - 9
            }

            // V624: BAR SUB-PIXEL SHIFT
            bar.set_style(`transform: translateX(${marginShift.toFixed(3)}px);`)

            if (active || Math.abs(smoothedBarWidth - totalIntWidth) > 0.01) {
                smoothedBarWidth = totalIntWidth
                updateSize()
                updateInputRegion(smoothedBarWidth)
                active = true
            }

            if (!active) {
                tickId = null; lastFrameTime = 0
                return false
            }
            return true
        })
    }

    let lastMouseX = -1000
    const updateAllTargets = (mouseX: number) => {
        // V320: Freeze magnification shifts while a menu is open to prevent "ghost menu" flickering
        if ((globalThis as any).isAnyMenuOpen) return

        const screenWidth = gdkmonitor.get_geometry().width
        lastMouseX = mouseX

        // V622: STABLE PROJECTION REFERENCE
        // We calculate what the TOTAL width WILL be if the current mouse position 
        // stays where it is. This breaks the feedback loop between animating icons 
        // and its own projection source.
        let targetTotalWidth = 0
        orderedIds.forEach(id => {
            const state = animRegistry.get(id)
            if (state) {
                // Approximate target expansion for this frame's pX estimation
                const m = calculateDockItemMetrics(mouseX, state.staticCenter, state.isSeparator)
                targetTotalWidth += m.width + (m.margin * 2)
            }
        })

        const pX = lastMouseX === -1000 ? -1000 : getProjectedMouseX(
            lastMouseX,
            screenWidth,
            totalStaticWidth,
            targetTotalWidth || totalStaticWidth
        )

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
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.BASE_MARGIN
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
        runUnifiedTick()
    }

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { })
    const updateInputRegion = (totalWidth: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

        // dockMonitorWidth already declared at top
        const region = new Cairo.Region()

        // V300: Surgical Input Region for 200px window.
        // The window is 200px high to allow icon magnification, but we ONLY
        // capture mouse events in the bottom 110px (Dock area).

        // V421: SMART INPUT REGION
        // If a menu is open, we MUST allow input on the full window (200px) so the menu can receive clicks.
        // If no menu is open, we MUST clip to the bottom 110px so we don't block windows behind the dock.
        if ((globalThis as any).isAnyMenuOpen) {
            surface.set_input_region(null) // Full window input
            return
        }

        // V422: GENEROUS INPUT REGION
        // We expand the interaction zone by 250px on each side to ensure
        // the magnification starts growing SMOOTHLY before the mouse hits the icons.
        // This eliminates the "jump" reported by the user.
        const width = totalWidth + 500
        const x = (dockMonitorWidth - width) / 2
        const y = 200 - 110

        // @ts-ignore
        region.unionRectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: 110 })
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
        clearLeaveTimeout() // V160: Cancel any pending leave reset

        // V478: DRAG PERSISTENCE
        // While dragging, we IGNORE the vertical limit. Reordering and magnification
        // must stay active as long as the drag is alive.
        if (dragBus.draggingId) {
            updateAllTargets(x)
            return
        }

        // V215: Normal operation (not dragging)
        // We only magnify if the mouse is in the bottom 110px.
        const yLimit = 200 - 110
        if (y < yLimit) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        // V477: Do NOT reset during drag. This prevents magnification cut-outs
        // if the user's hand wanders slightly while dragging.
        if (dragBus.draggingId) return

        clearLeaveTimeout()
        leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            updateAllTargets(-1000)
            leaveTimeout = null
            return GLib.SOURCE_REMOVE
        })
    })

    const shim = new Gtk.Box({
        valign: Gtk.Align.END, halign: Gtk.Align.START, // V601: Logic Anchor
        margin_bottom: 10,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        vexpand: true,
        overflow: Gtk.Overflow.VISIBLE,
    })
    bar.valign = Gtk.Align.END
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
            // V310: PROTECTION. If a menu is open, skip reconciliation to prevent widget tree shifts (the "ghost menu" fix).
            if ((globalThis as any).isAnyMenuOpen) {
                needsUpdate = true // Try again later
                return bar
            }

            needsUpdate = false
            const groupedClients: { [key: string]: { addresses: string[], displayClass: string, title: string } } = {}
            const sortedClients = [...hypr.clients].sort((a, b) => a.address.localeCompare(b.address))
            sortedClients.forEach(c => {
                const rawClass = c.class || ""
                if (rawClass.toLowerCase().includes("ags")) return
                const key = rawClass.toLowerCase()
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
                runningUnpinnedKeys = groupedKeys.filter(k => k !== nsid && !pinnedState.list.some(p => norm(p) === k))

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
                runningUnpinnedKeys = groupedKeys.filter(k => !pinnedState.list.some(p => norm(p) === k))
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
                    transition_type: Gtk.RevealerTransitionType.SLIDE_LEFT,
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

            const findApp = (searchId: string) => {
                if (!searchId) return null
                const lid = searchId.toLowerCase().replace(".desktop", "")

                // V505: Rename local 'app' to 'targetApp' to avoid shadowing global 'app' import
                let targetApp = apps.list.find(a => {
                    const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                    return aid === lid
                })

                if (!targetApp && lid.includes(".")) {
                    const parts = lid.split(".")
                    const lastPart = parts[parts.length - 1]
                    targetApp = apps.list.find(a => {
                        const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                        return aid.includes(lastPart)
                    })
                }

                if (!targetApp) {
                    const fuzzyList = [lid, lid.split(".").pop() || "", lid.replace("org.", "").replace("com.", "")]
                    for (const f of fuzzyList) {
                        const found = apps.list.find(a => {
                            const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase()
                            return aid.includes(f)
                        })
                        if (found) {
                            targetApp = found
                            break
                        }
                    }
                }

                if (!targetApp) {
                    targetApp = apps.list.find(a => {
                        const name = a.get_name().toLowerCase()
                        return name.includes(lid) || lid.includes(name)
                    })
                }

                if (!targetApp) {
                    targetApp = apps.list.find(a => {
                        const exec = a.get_executable() || ""
                        return exec.toLowerCase().includes(lid) || lid.includes(exec.toLowerCase())
                    })
                }

                // Specialized Telegram Match for EndeavourOS/Wayland
                if (!targetApp && (lid.includes("telegram") || lid.includes("tg"))) {
                    targetApp = apps.list.find(a => {
                        const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase()
                        return aid.includes("telegram")
                    })
                }

                if (!targetApp) {
                    const data = appService.getAppData(lid)
                    if (data) {
                        return {
                            name: data.name,
                            icon_name: data.icon || lid,
                            id: data.id,
                            get_id: () => data.id,
                            get_name: () => data.name,
                            launch: () => execAsync(`gtk-launch ${data.id || lid}`).catch(print)
                        } as any
                    }
                }
                return targetApp
            }


            const userName = GLib.get_user_name()
            const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

            const homeItem = {
                name: prettyName,
                icon_name: ["user-home", "folder-home", "folder"],
                launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(e => {
                    // @ts-ignore
                    print(e)
                })
            }
            configs.push({
                id: "home-shortcut", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: homeItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "home-shortcut",
                        appItem: homeItem as any,
                        updateDock: update,
                        register: (id, s) => animRegistry.set(id, s),
                        addresses: [],
                        clientTitle: undefined,
                        onPin, onUnpin, onReorder,
                        isPinned: true, // Special item logic handles actions
                        cleanId: "home-shortcut"
                    }, bar)

                    // V402: Debug Home Shortcut (First Item)
                    // @ts-ignore
                    print("[Dock] Home Shortcut exposed for debugging")
                    debugLauncherState(w)

                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

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
                    const info = apps.getAppInfo(lid)
                    const displayName = info?.get_name() || lid
                    let icon = info?.get_id() || originalId
                    if (lid.startsWith("chrome-") && lid.endsWith("-default") && typeof icon === "string") {
                        icon = icon.replace(/-default$/i, "-Default")
                    }
                    const ghost = { name: displayName, icon_name: icon, launch: getLaunch(lid) } as any
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
                    const w = Separator(separatorId, update, (id, s) => animRegistry.set(id, s), 64, onReorder)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            runningUnpinnedKeys.forEach(k => {
                const group = groupedClients[k]
                const lid = k.toLowerCase().replace(".desktop", "")

                let appItem = findApp(group?.displayClass || k)
                if (!appItem) {
                    appItem = {
                        name: group?.title || group?.displayClass || k,
                        icon_name: group?.displayClass || lid,
                        launch: getLaunch(lid)
                    } as any
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
                    const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), 64, onReorder)
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
            const screenWidth2 = gdkmonitor.get_geometry().width
            let targetTotalWidth = 0
            orderedIds.forEach(id => {
                const state = animRegistry.get(id)
                if (state) {
                    const m = calculateDockItemMetrics(lastMouseX, state.staticCenter, state.isSeparator)
                    targetTotalWidth += m.width + (m.margin * 2)
                }
            })

            const pX_sync = lastMouseX === -1000 ? -1000 : getProjectedMouseX(lastMouseX, screenWidth2, totalStaticWidth, targetTotalWidth || totalStaticWidth)

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
                const manualMarginStart = Math.round((dockMonitorWidth - smoothedBarWidth) / 2)
                bar.margin_start = manualMarginStart
                if (da) da.margin_start = manualMarginStart - 9
                updateSize()
                firstRender = false
            }

            if (!tickId) runUnifiedTick()
            if (!skipTargets) updateAllTargets(lastMouseX)
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
    win.set_default_size(dockMonitorWidth, 200) // V300: High window prevents icon clipping
    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) {
        console.warn("Gtk4LayerShell init failed (not on Wayland?): " + e)
    }
    win.set_size_request(dockMonitorWidth, 200)
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
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true);
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true);
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 0);
            if (orderedIds.length > 0) {
                let total = 0
                orderedIds.forEach(id => {
                    const s = animRegistry.get(id)
                    if (s) total += s.currentWidth + (s.currentMargin * 2)
                })
                updateInputRegion(total)
            }

            Gtk4LayerShell.set_exclusive_zone(win, DOCK_CONSTANTS.EXCLUSIVE_ZONE);

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

            console.log(`[Dock] Drag Start: Anchoring grid at ${lockedStartX} (width ${lockedStaticWidth})`)

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
        try { if (cConn) GObject.signal_handler_disconnect(hypr, cConn) } catch (e) { }
        try { if (fConn) GObject.signal_handler_disconnect(hypr, fConn) } catch (e) { }
        try { if (aConn) GObject.signal_handler_disconnect(appService, aConn) } catch (e) { }
        try { if (dConn) dConn() } catch (e) { }
        try { if (mSub) mSub() } catch (e) { }
    })
    win.connect("destroy", () => {
        // V84: Aggressive Cleanup to prevent "failed to find wayland buffer"
        if (tickId) {
            bar.remove_tick_callback(tickId)
            tickId = null
        }
        hypr.disconnect(cConn)
        hypr.disconnect(fConn)
        aConn()
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
