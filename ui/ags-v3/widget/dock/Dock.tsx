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

// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const hypr = AstalHyprland.get_default()
const appsService = new AstalApps.Apps()

const DOCK_CONFIG = {
    USE_ICON_PLATES: true,
    SMART_PLATES_FOR_FILES: true,
    MAX_ICON_SIZE: 160,
    MAGNIFICATION_SCALE: 2.2,
    HOME_ICON_FALLBACK: ["user-home", "system-file-manager", "folder"],
}

let pinnedList: string[] = []
try {
    const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
    const oldLen = raw.length
    pinnedList = [...new Set(raw)]
        .filter(id => id && !id.startsWith("/"))
        .map(id => id.replace(/^pinned-/, "").replace(/^pinned-ghost-/, "").replace(/^running-/, ""))

    if (pinnedList.length !== oldLen) {
        writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
    }
} catch {
    pinnedList = []
}

const savePinned = () => {
    console.log(`[Dock] Saving pinned list: ${JSON.stringify(pinnedList)} `);
    writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
}

// --- MOUSE BUS FOR MAGNIFICATION ---
const mouseBus = {
    listeners: new Set<(x: number) => void>(),
    emit(x: number) { this.listeners.forEach(l => l(x)) },
    subscribe(l: (x: number) => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
}


export default function Dock(gdkmonitor: any) {
    console.log("[Dock] Function Called for monitor")
    // V180: Sync initial width with pinned items to prevent "One-Time Jump" on startup
    const initialCount = pinnedList.length + 3 // Launcher + Home + Trash
    let totalStaticWidth = initialCount * 82
    const widgetCache = new Map<string, Gtk.Widget>()
    let firstRender = true

    // Create Layout First
    const layout = new Gtk.Overlay({
        name: "dock-main-overlay",
        css_classes: ["cd-main-overlay"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL,
        overflow: Gtk.Overflow.VISIBLE
    })

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
            const manualMarginStart = Math.round((monitorWidth - totalIntWidth) / 2)

            if (bar.get_halign() !== Gtk.Align.START) bar.set_halign(Gtk.Align.START)
            if (bar.margin_start !== manualMarginStart) {
                bar.margin_start = manualMarginStart
            }

            if (Math.abs(smoothedBarWidth - totalIntWidth) > 0.01) {
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


    let lastMouseX = -1000
    const updateAllTargets = (mouseX: number) => {
        // V320: Freeze magnification shifts while a menu is open to prevent "ghost menu" flickering
        if ((globalThis as any).isAnyMenuOpen) return

        lastMouseX = mouseX
        const qX = mouseX

        animRegistry.forEach((state) => {
            if (qX === -1000) {
                state.targetScale = 1.0
                if (state.isSeparator) {
                    state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
                } else {
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.BASE_MARGIN
                }
            } else {
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
        // V215: Correct for 200px window height. 
        // We only magnify if the mouse is in the bottom 110px.
        const yLimit = 200 - 110
        if (y < yLimit) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        // V160: Debounce leave event to prevent flicker when resizing or crossing gaps
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

    // V136: Architecture Simplification
    // The DrawingArea is now the primary child (Background), removing 'pillBg' to prevent double backgrounds.
    layout.set_child(da)
    layout.add_overlay(shim)


    let updateLock = false
    let needsUpdate = false

    const update = () => {
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
            type ItemConfig = { id: string, width: number, syncData?: any, isPinned: boolean, factory: (vc: number) => Gtk.Widget }
            const configs: ItemConfig[] = []
            const currentIds = new Set<string>()

            const getOrCreateItem = (id: string, factory: () => Gtk.Widget) => {
                currentIds.add(id)
                if (widgetCache.has(id)) {
                    return widgetCache.get(id)!
                }
                const widget = factory()
                const revealer = new (Gtk as any).Revealer({
                    css_classes: ["cd-revealer"],
                    transition_type: Gtk.RevealerTransitionType.SLIDE_LEFT,
                    transition_duration: 300,
                    child: widget,
                    reveal_child: firstRender // V150: Instant show on startup
                })
                if (!firstRender) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { revealer.reveal_child = true; return GLib.SOURCE_REMOVE })
                }
                widgetCache.set(id, revealer)
                return revealer
            }

            // V150: Mark first render complete after this batch
            if (firstRender) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { firstRender = false; return GLib.SOURCE_REMOVE })
            }

            // Dismantle popovers before update to prevent ghosting/hangs
            widgetCache.forEach(w => {
                const inner = (w as any).get_child()
                if (inner && (inner as any).popdown) (inner as any).popdown()
            })

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

            const findApp = (searchId: string) => {
                if (!searchId) return null
                const lid = searchId.toLowerCase().replace(".desktop", "")
                let app = appsService.list.find(a => {
                    const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                    return aid === lid
                })

                if (!app && lid.includes(".")) {
                    const parts = lid.split(".")
                    const lastPart = parts[parts.length - 1]
                    app = appsService.list.find(a => {
                        const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                        return aid.includes(lastPart)
                    })
                }

                if (!app) {
                    const fuzzyList = [lid, lid.split(".").pop() || "", lid.replace("org.", "").replace("com.", "")]
                    for (const f of fuzzyList) {
                        app = appsService.fuzzy_query(f)?.[0]
                        if (app) break
                    }
                }

                // Specialized Telegram Match for EndeavourOS/Wayland
                if (!app && (lid.includes("telegram") || lid.includes("tg"))) {
                    app = appsService.list.find(a => {
                        const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase()
                        return aid.includes("telegram")
                    })
                }

                if (!app) {
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
                return app
            }

            const getLaunch = (lid: string) => {
                const app = appService.getAppData(lid)
                const desktopId = app?.id || lid
                return () => execAsync(`gtk-launch ${desktopId}`).catch(print)
            }

            // Logic for callbacks with normalization
            const norm = (s: string) => s.toLowerCase().replace(".desktop", "")
            const onPin = (sourceId: string) => {
                const nid = norm(sourceId)
                pinnedList = pinnedList.filter(p => norm(p) !== nid)
                pinnedList.unshift(sourceId)
                savePinned(); update()
            }
            const onUnpin = (sourceId: string) => {
                const nid = norm(sourceId)
                pinnedList = pinnedList.filter(p => norm(p) !== nid)
                savePinned(); update()
            }
            const onReorder = (sourceId: string, targetId: string) => {
                const nsid = norm(sourceId)
                const ntid = norm(targetId)
                pinnedList = pinnedList.filter(p => norm(p) !== nsid)
                let newIdx = pinnedList.findIndex(p => norm(p) === ntid)
                if (newIdx === -1) newIdx = pinnedList.length
                pinnedList.splice(newIdx, 0, sourceId)
                savePinned(); update()
            }
            const onDropSeparator = (sourceId: string) => {
                const nid = norm(sourceId)
                pinnedList = pinnedList.filter(p => norm(p) !== nid)
                pinnedList.push(sourceId)
                savePinned(); update()
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

            pinnedList.filter(id => !!id && !id.startsWith("special:") && id !== "trash" && id !== "launcher").forEach(id => {
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
                    const info = appService.getAppInfo(lid)
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

            const runKeys = Object.keys(groupedClients)
            runKeys.forEach(k => {
                const group = groupedClients[k]
                let appItem = findApp(group.displayClass)
                const lid = k.toLowerCase().replace(".desktop", "")
                if (!appItem) {
                    appItem = {
                        name: group.title || group.displayClass,
                        icon_name: group.displayClass || lid,
                        launch: getLaunch(lid)
                    } as any
                }
                if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                    if (typeof appItem.icon_name === "string") {
                        appItem.icon_name = appItem.icon_name.replace(/-default$/i, "-Default")
                    }
                }
                configs.push({
                    id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                    syncData: { addrs: group.addresses, clientTitle: group.title, appItem: appItem! },
                    isPinned: false,
                    factory: (vc) => {
                        const w = DockItem({
                            appId: lid,
                            appItem: appItem!,
                            updateDock: update,
                            register: (id, s) => animRegistry.set(id, s),
                            addresses: group.addresses,
                            clientTitle: group.title,
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
                    const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), 64, onDropSeparator)
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

            const count = configs.length
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
            updateAllTargets(lastMouseX)
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
        updateTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            update(); updateTimer = null; return GLib.SOURCE_REMOVE
        })
    }

    const cConn = hypr.connect("notify::clients", throttledUpdate)
    const fConn = hypr.connect("notify::focused-client", throttledUpdate)
    const aConn = appService.connect(throttledUpdate)
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
