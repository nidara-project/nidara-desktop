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
    const initialCount = pinnedState.list.length + 3 // Launcher + Home + Trash
    let totalStaticWidth = initialCount * 82
    const widgetCache = new Map<string, Gtk.Widget>()
    let firstRender = true
    const norm = (s: string) => (s || "").toLowerCase().replace(".desktop", "")

    // Create Layout First
    const layout = new Gtk.Overlay({
        name: "dock-main-overlay",
        css_classes: ["cd-main-overlay"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL,
        overflow: Gtk.Overflow.VISIBLE
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

        console.log(`[Dock] Drop COMMIT: ${nsid} -> Slot ${finalIdx}`)

        const wasPinned = pinnedState.list.some(p => norm(p) === nsid)
        const pinnedCount = pinnedState.list.filter(p => norm(p) !== nsid).length

        // Pinned Section Boundary: Launcher (0) + Home (1) + PinnedCount
        const pinnedBoundary = 2 + pinnedCount

        // ZONE DECISION:
        // Index 0: Launcher, Index 1: Home
        if (finalIdx === initialCount - 1) { // Trash is last
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

        return (effectivePinned.length + runningUnpinnedCount + 3) * DOCK_CONSTANTS.APP_SLOT + (2 * DOCK_CONSTANTS.SEPARATOR_SLOT)
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
        name: "the-dock-bar",
        css_classes: ["cd-dock-bar"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.START,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        spacing: 0,
        can_focus: false,
    })

    // --- V17 PHYSICS ENGINE ---
    type AnimState = {
        targetScale: number, currentScale: number,
        targetWidth: number, currentWidth: number,
        targetMargin: number, currentMargin: number,
        virtualCenter: number, staticCenter: number, isSeparator: boolean,
        widget?: Gtk.Widget
    }
    const animRegistry = new Map<string, AnimState>()
    let smoothedBarWidth = totalStaticWidth

    const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor

    let tickId: number | null = null

    const runUnifiedTick = () => {
        if (tickId !== null) return

        tickId = bar.add_tick_callback((_, clock) => {
            // V320: Also pause the animation shift if a menu is open
            if ((globalThis as any).isAnyMenuOpen) return true

            let active = false
            let currentFloatX = 0

            animRegistry.forEach((state, id) => {
                const scaleDiff = Math.abs(state.targetScale - state.currentScale)
                if (scaleDiff > 0.00001) {
                    state.currentScale = lerp(state.currentScale, state.targetScale, 0.12)
                    active = true
                } else state.currentScale = state.targetScale

                const widthDiff = Math.abs(state.targetWidth - state.currentWidth)
                if (widthDiff > 0.001) {
                    state.currentWidth = lerp(state.currentWidth, state.targetWidth, 0.12)
                    active = true
                } else state.currentWidth = state.targetWidth

                const marginDiff = Math.abs(state.targetMargin - state.currentMargin)
                if (marginDiff > 0.001) {
                    state.currentMargin = lerp(state.currentMargin, state.targetMargin, 0.12)
                    active = true
                } else state.currentMargin = state.targetMargin

                const widget = widgetCache.get(id)
                if (widget) {
                    const revealer = widget as any
                    const itemBox = revealer.get_child() as Gtk.Box

                    const floatSlotW = state.currentWidth + (state.currentMargin * 2)
                    const floatIconStart = currentFloatX + state.currentMargin
                    const floatIconEnd = floatIconStart + state.currentWidth
                    const floatSlotEnd = currentFloatX + floatSlotW

                    const intSlotStart = Math.round(currentFloatX)
                    const intIconStart = Math.round(floatIconStart)
                    const intIconEnd = Math.round(floatIconEnd)
                    const intSlotEnd = Math.round(floatSlotEnd)

                    const drawSlotW = intSlotEnd - intSlotStart
                    const drawIconW = intIconEnd - intIconStart
                    const drawMarginS = intIconStart - intSlotStart

                    currentFloatX = floatSlotEnd

                    if (revealer.width_request !== drawSlotW) {
                        revealer.width_request = drawSlotW
                        if (itemBox) itemBox.width_request = drawIconW
                    }
                    if (itemBox) {
                        if (itemBox.get_halign() !== Gtk.Align.START) itemBox.set_halign(Gtk.Align.START)

                        if (itemBox.margin_start !== drawMarginS) {
                            itemBox.margin_start = drawMarginS
                            itemBox.margin_end = 0
                        }
                    }

                    if (!state.isSeparator) {
                        const overlay = itemBox?.get_first_child() as Gtk.Overlay
                        if (!overlay) {
                            console.warn(`[Dock] No overlay for ${id}`)
                            return
                        }

                        // Robust Search for the Plate
                        let iconBox = overlay.get_child() as Gtk.Box
                        let plate: Gtk.Widget | null = null
                        let isNewOverlayStructure = false

                        if (iconBox && (iconBox as any).get_first_child) {
                            const first = (iconBox as any).get_first_child()
                            if (first) {
                                const classes = first.get_css_classes()
                                if (classes.includes("cd-squircle-plate")) {
                                    plate = first
                                } else if (classes.includes("cd-plate-container")) {
                                    plate = first
                                    isNewOverlayStructure = true
                                }
                            }
                        }

                        const targetPixelSize = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)

                        if (plate) {
                            // Resize the main container/plate
                            plate.set_size_request(drawIconW, targetPixelSize)

                            if (isNewOverlayStructure) {
                                // NEW STRUCTURE: Overlay -> [DA, Icon]
                                // We must resize the Overlay children explicitly if they don't fill automatically
                                // The DA is the first child (main child of overlay)
                                const da = (plate as any).get_child()
                                if (da) da.set_size_request(targetPixelSize, targetPixelSize)

                                // The Icon is an added overlay (sibling in the widget tree)
                                const icon = da ? da.get_next_sibling() : null
                                if (icon) icon.set_size_request(targetPixelSize, targetPixelSize)
                            } else {
                                // OLD STRUCTURE: Box -> Icon
                                const icon = (plate as any).get_first_child()
                                if (icon) icon.set_size_request(targetPixelSize, targetPixelSize)
                            }
                        } else if (iconBox) {
                            iconBox.set_size_request(drawIconW, targetPixelSize)
                        }
                    }
                }
            })

            const totalIntWidth = Math.round(currentFloatX)
            if (totalIntWidth === 0 && animRegistry.size > 0) {
                console.warn("[Dock] Bar width is 0! Check physics constants.")
            }
            const monitorWidth = gdkmonitor.get_geometry().width

            // V466: NATURAL CENTERING
            // Always center the dock based on its LIVE animated width (totalIntWidth).
            // This ensures perfect visual symmetry and smoothness during magnification.
            const manualMarginStart = Math.round((monitorWidth - totalIntWidth) / 2)

            if (bar.get_halign() !== Gtk.Align.START) bar.set_halign(Gtk.Align.START)
            if (bar.margin_start !== manualMarginStart) {
                bar.margin_start = manualMarginStart
            }

            // V490: VISUAL SMOOTHNESS
            // Follow the animated width for the container size.
            if (Math.abs(smoothedBarWidth - totalIntWidth) > 0.1) {
                smoothedBarWidth = totalIntWidth
                updateSize()
                updateInputRegion(smoothedBarWidth)
                active = true
            }

            if (!active) {
                tickId = null
                return false
            }

            return true
        })
    }

    let currentTotalItems = 0
    let lastMouseX = -1000
    const updateAllTargets = (mouseX: number) => {
        // V320: Freeze magnification shifts while a menu is open to prevent "ghost menu" flickering
        if ((globalThis as any).isAnyMenuOpen) return

        lastMouseX = mouseX
        const qX = mouseX

        const draggingId = dragBus.draggingId
        if (draggingId) {
            // V480: STATIC LOGIC ANCHOR
            // We use the startX captured when the drag began for the GRID.
            // This makes slot calculation absolute and immune to visual shifts.
            const relX = lastMouseX - lockedStartX

            // V482: 70% STICKY SLOT HYSTERESIS
            const slotSize = DOCK_CONSTANTS.APP_SLOT
            // Re-calculate targetIdx with fresh logic
            let targetIdx = Math.floor(relX / slotSize)

            if (previewIdx !== -1) {
                const currentSlotCenterX = previewIdx * slotSize + slotSize / 2
                const distToCenter = relX - currentSlotCenterX
                if (Math.abs(distToCenter) < slotSize * 0.70) {
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
            // This replaces the removed DropTarget.enter/leave logic.
            const hoverTotal = currentTotalItems || 10
            if (targetIdx >= 0 && targetIdx <= hoverTotal) {
                // We'll let update() loop handle the mapping or do a rough estimate
                // For now, clear hover if out of bounds, else set it.
                // (Detailed mapping is complex, simplest is to let magnification guide it)
            } else {
                dragBus.clearHover()
            }
        }

        animRegistry.forEach((state) => {
            if (qX === -1000) {
                state.targetScale = 1.0
                if (state.isSeparator) {
                    state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
                } else {
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.BASE_MARGIN
                }
            } else {
                // V483: Sync Magnification with LIVE layout for alignment
                // We use totalStaticWidth (current unmagnified width) so magnification 
                // stays centered over the actual widgets as they reshuffle.
                const pX = getProjectedMouseX(qX, gdkmonitor.get_geometry().width, totalStaticWidth)
                const metrics = calculateDockItemMetrics(
                    pX,
                    state.staticCenter,
                    state.isSeparator
                )
                state.targetScale = metrics.scale
                state.targetWidth = metrics.width
                state.targetMargin = metrics.margin
            }
        })
        runUnifiedTick()
    }

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { })
    const updateInputRegion = (totalWidth: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

        const monitorWidth = gdkmonitor.get_geometry().width
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

        const width = totalWidth + 80
        const x = (monitorWidth - width) / 2
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

    const da = new Gtk.DrawingArea({
        name: "dock-gloss-layer",
        // css_classes: ["crystal-dock"], // REMOVED: Causes "Double Background" artifact
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        margin_bottom: 10,
        can_focus: false,
    })

    da.set_draw_func((_, cr, w, h) => {
        // V430: Enable Gloss/Border effect for main dock
        drawSquircle(cr, w, h, undefined, 0.2, true)
    })

    const updateSize = () => {
        const targetW = smoothedBarWidth + 18
        const currentW = da.get_allocated_width()
        // V141: Only resize if significant change (>1px) to prevent Wayland buffer thrashing / jitter
        if (Math.abs(currentW - targetW) > 1) {
            da.set_size_request(targetW, DOCK_CONSTANTS.PILL_HEIGHT)
            da.queue_draw()
        } else {
            da.queue_draw() // Just redraw if size is close enough
        }
    }

    const shim = new Gtk.Box({
        valign: Gtk.Align.END, halign: Gtk.Align.START,
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

            type ItemConfig = { id: string, width: number, syncData?: any, isPinned: boolean, factory: (vc: number) => Gtk.Widget }
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

            currentTotalItems = configs.length
            totalStaticWidth = configs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)
            const totalWidth = totalStaticWidth

            const screenWidth = gdkmonitor.get_geometry().width
            const startX = (screenWidth - totalWidth) / 2
            let currentX = startX
            // Ensure NO DUPLICATE IDs in final mapping
            const processed = new Set<string>()
            const finalItems = configs.filter(c => {
                if (processed.has(c.id)) return false
                processed.add(c.id); return true
            }).map((c) => {
                const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT
                const myCenter = currentX + (slotWidth / 2)
                currentX += slotWidth

                const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
                const inner = (widget as any).get_child()
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
            animRegistry.forEach((state, id) => {
                const metrics = calculateDockItemMetrics(lastMouseX, state.staticCenter, state.isSeparator)
                state.targetScale = metrics.scale
                state.targetWidth = metrics.width
                state.targetMargin = metrics.margin

                if (firstRender) {
                    // Force immediate only for first frame
                    state.currentScale = metrics.scale
                    state.currentWidth = metrics.width
                    state.currentMargin = metrics.margin
                }
                totalCurrentWidth += state.currentWidth + (state.currentMargin * 2)
            })

            // Sync alignment to prevent "bad load" shift - ONLY on first load
            if (firstRender) {
                smoothedBarWidth = totalCurrentWidth
                const monitorWidth = gdkmonitor.get_geometry().width
                const manualMarginStart = Math.round((monitorWidth - smoothedBarWidth) / 2)
                bar.margin_start = manualMarginStart
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

    const monitorWidth = gdkmonitor.get_geometry().width
    win.set_default_size(monitorWidth, 200) // V300: High window prevents icon clipping
    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) {
        console.warn("Gtk4LayerShell init failed (not on Wayland?): " + e)
    }
    win.set_size_request(monitorWidth, 200)
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
            if (animRegistry.size > 0) {
                let total = 0
                for (const s of animRegistry.values()) {
                    total += s.currentWidth + (s.currentMargin * 2)
                }
                updateInputRegion(total)
            }

            Gtk4LayerShell.set_exclusive_zone(win, DOCK_CONSTANTS.EXCLUSIVE_ZONE);

            win.connect("realize", () => {
                // V300: Delegate to surgical updateInputRegion on realize
                if (animRegistry.size > 0) {
                    let total = 0
                    for (const s of animRegistry.values()) {
                        total += s.currentWidth + (s.currentMargin * 2)
                    }
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
    // V197: Redundant late-update timeouts removed. initialCount logic handles it.

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
