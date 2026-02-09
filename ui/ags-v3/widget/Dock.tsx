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
import appService from "../core/AppService" // Ensure path correctness
import { DockItem, Separator } from "./DockItem"
import { drawSquircle } from "./DockUtils"

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
    let totalStaticWidth = 400
    const widgetCache = new Map<string, Gtk.Widget>()

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
        default_height: 120,
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
    let smoothedBarWidth = 200

    const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor

    let tickId: number | null = null

    const runUnifiedTick = () => {
        if (tickId !== null) return

        tickId = bar.add_tick_callback((_, clock) => {
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

                        if (iconBox && (iconBox as any).get_first_child) {
                            const first = (iconBox as any).get_first_child()
                            if (first && first.get_css_classes().includes("cd-squircle-plate")) {
                                plate = first
                            }
                        }

                        const targetPixelSize = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)

                        if (plate) {
                            plate.set_size_request(drawIconW, targetPixelSize)
                            const icon = (plate as any).get_first_child()
                            if (icon) icon.set_size_request(targetPixelSize, targetPixelSize)
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
        const yOffset = DOCK_CONSTANTS.WINDOW_HEIGHT - DOCK_CONSTANTS.PILL_HEIGHT - 10
        // @ts-ignore
        region.unionRectangle({ x: 0, y: yOffset, width: monitorWidth, height: DOCK_CONSTANTS.PILL_HEIGHT })
        surface.set_input_region(region)
    }

    win.add_controller(motion)
    motion.connect("motion", (controller, x, y) => {
        const yOffset = DOCK_CONSTANTS.WINDOW_HEIGHT - DOCK_CONSTANTS.PILL_HEIGHT - 10
        if (y < yOffset) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        updateAllTargets(-1000)
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
        drawSquircle(cr, w, h)
    })

    const updateSize = () => {
        const w = smoothedBarWidth + 18
        da.set_size_request(w, DOCK_CONSTANTS.PILL_HEIGHT)
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


    const update = () => {
        type ItemConfig = { id: string, width: number, syncData?: any, factory: (vc: number) => Gtk.Widget }
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
                reveal_child: false
            })
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { revealer.reveal_child = true; return GLib.SOURCE_REMOVE })
            widgetCache.set(id, revealer)
            return revealer
        }

        const groupedClients: { [key: string]: { addresses: string[], displayClass: string, title: string } } = {}
        hypr.clients.forEach(c => {
            const rawClass = c.class || ""
            if (rawClass.toLowerCase().includes("ags")) return
            const key = rawClass.toLowerCase()
            if (!groupedClients[key]) {
                groupedClients[key] = { addresses: [], displayClass: rawClass, title: c.title }
            }
            groupedClients[key].addresses.push(c.address)
        })

        const findApp = (searchId: string) => {
            const lid = searchId.toLowerCase().replace(".desktop", "")
            let app = appsService.list.find(a => {
                const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                return aid === lid
            })
            if (!app) app = appsService.fuzzy_query(lid)?.[0]

            if (!app) {
                const data = appService.getAppData(lid)
                if (data) {
                    return {
                        name: data.name,
                        icon_name: data.icon || lid,
                        id: data.id,
                        get_id: () => data.id,
                        get_name: () => data.name,
                        launch: () => execAsync(`gtk-launch ${data.id}`).catch(print)
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

        // Logic for callbacks
        const onPin = (sourceId: string) => {
            pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
            pinnedList.unshift(sourceId)
            savePinned(); update()
        }
        const onUnpin = (sourceId: string) => {
            pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
            savePinned(); update()
        }
        const onReorder = (sourceId: string, targetId: string) => {
            pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
            let newIdx = pinnedList.findIndex(p => p.toLowerCase() === targetId)
            if (newIdx === -1) newIdx = pinnedList.length
            pinnedList.splice(newIdx, 0, sourceId)
            savePinned(); update()
        }
        const onDropSeparator = (sourceId: string) => {
            pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
            pinnedList.push(sourceId)
            savePinned(); update()
        }

        const userName = GLib.get_user_name()
        const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

        const homeItem = {
            name: prettyName,
            icon_name: ["user-home", "folder-home", "folder"],
            launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(print)
        }
        configs.push({
            id: "home-shortcut", width: DOCK_CONSTANTS.APP_SLOT,
            syncData: { addrs: [], clientTitle: undefined, appItem: homeItem as any },
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

        pinnedList.filter(id => !!id).forEach(id => {
            const lid = id.toLowerCase().replace(".desktop", "")
            const originalId = id.replace(".desktop", "")
            let appItem = findApp(id)
            const targetKey = lid
            const groupKey = Object.keys(groupedClients).find(k => k === targetKey || k.includes(targetKey))
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
            id: "trash", width: DOCK_CONSTANTS.APP_SLOT,
            syncData: { addrs: [], clientTitle: undefined, appItem: trash as any },
            factory: (vc) => {
                const w = DockItem({
                    appId: "trash",
                    appItem: trash as any,
                    updateDock: update,
                    register: (id, s) => animRegistry.set(id, s),
                    addresses: [],
                    clientTitle: undefined,
                    onPin, onUnpin, onReorder,
                    isPinned: true, // Special
                    cleanId: "trash"
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
        const finalItems = configs.map((c) => {
            const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT
            const myCenter = currentX + (slotWidth / 2)
            currentX += slotWidth

            const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
            const inner = (widget as any).get_child()
            if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)

            if (inner && (inner as any).syncState && (c as any).syncData) {
                const d = (c as any).syncData
                    ; (inner as any).syncState(d.addrs, d.clientTitle, d.appItem)
            }
            return widget
        })

        for (const [id, w] of widgetCache) {
            if (!currentIds.has(id)) {
                widgetCache.delete(id)
                animRegistry.delete(id)
            }
        }

        let widthError = 0
        let marginError = 0
        let lastWidget: Gtk.Revealer | null = null

        animRegistry.forEach((state, id) => {
            state.targetScale = 1.0
            if (state.isSeparator) {
                state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0
            } else {
                state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.BASE_MARGIN
            }
            state.currentScale = 1.0
            state.currentWidth = state.targetWidth
            state.currentMargin = state.targetMargin
        })

        if (!tickId) runUnifiedTick()
        updateAllTargets(-1000)
        runUnifiedTick()

        const currentChildren = [] as Gtk.Widget[]
        let child = bar.get_first_child()
        while (child) { currentChildren.push(child); child = child.get_next_sibling() }

        currentChildren.forEach(c => bar.remove(c))
        finalItems.forEach(i => bar.append(i))

        updateSize()
        return bar
    }

    const monitorWidth = gdkmonitor.get_geometry().width
    win.set_default_size(monitorWidth, 200)
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
                const surface = win.get_native()?.get_surface()
                if (surface) {
                    const monitorWidth = gdkmonitor.get_geometry().width
                    const region = new Cairo.Region()
                    const yOffset = DOCK_CONSTANTS.WINDOW_HEIGHT - DOCK_CONSTANTS.PILL_HEIGHT - 10
                    // @ts-ignore
                    region.unionRectangle({ x: 0, y: yOffset, width: monitorWidth, height: DOCK_CONSTANTS.PILL_HEIGHT })
                    surface.set_input_region(region)
                }
            })
        } catch (e) { console.error(e) }
    }

    const cConn = hypr.connect("notify::clients", update)
    const fConn = hypr.connect("notify::focused-client", () => {
        update()
        const focusedAddr = hypr.focusedClient?.address
        animRegistry.forEach((state, id) => {
            const widget = state.widget
            if (widget && (widget as any).syncState) {
                const currentAddrs = (state as any).addresses || []
                if (currentAddrs.length > 0) {
                    if (focusedAddr && currentAddrs.includes(focusedAddr)) {
                        widget.add_css_class("focused")
                    } else {
                        widget.remove_css_class("focused")
                    }
                }
            }
        })
    })
    const aConn = appService.connect(update)
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
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { update(); return GLib.SOURCE_REMOVE })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { update(); return GLib.SOURCE_REMOVE })

    win.present()
    return win
}
