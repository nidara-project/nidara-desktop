import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import appService from "../core/AppService" // Ensure import path is correct relative to this file
import { DOCK_CONSTANTS } from "./DockPhysics"

const hypr = AstalHyprland.get_default()

// --- PERSISTENCE (Moved to share state if needed, but for now referencing global or passing as props?)
// Ideally DockItem shouldn't manage global pinned state directly, but for now we follow existing pattern.
// To avoid circular dependency or complex state management refactor, we will export the list management 
// or keep it in Dock.tsx and pass callbacks. 
// However, the original code had `pinnedList` as a module-level variable in Dock.tsx. 
// To extract DockItem, we need to either:
// 1. Pass `pinnedList` and `setPinnedList` (or similar) as props.
// 2. Move `pinnedList` management to a separate state file.

// Option 2 is cleaner for "simplification". Let's create a simple state manager or valid approach.
// For this step, I'll keep it simple: Pass callbacks for pinning logic.

// --- STATE: Pure JS EventBus (No GObject complexity) ---
export const dragBus = {
    listeners: [] as ((id: string) => void)[],
    subscribe(fn: (id: string) => void) {
        this.listeners.push(fn)
        return () => { this.listeners = this.listeners.filter(l => l !== fn) }
    },
    update(id: string) {
        // console.log(`[DragBus] Update: "${id}"`) // Explicit Log
        this.listeners.forEach(fn => fn(id))
    }
}

// SEPARATOR COMPONENT
export function Separator(id: string, updateDock: () => void, register: (id: string, s: any) => void, height = 48,
    // Callbacks for drop logic
    onDrop: (sourceId: string) => void
) {
    const baseWidth = DOCK_CONSTANTS.SEPARATOR_SLOT
    const box = new Gtk.CenterBox({
        css_classes: ["cd-separator-container"],
        valign: Gtk.Align.END, halign: Gtk.Align.CENTER,
        width_request: baseWidth,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        hexpand: false,
        margin_bottom: 0,
    })

    const line = new Gtk.Box({
        name: "cd-separator", css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER,
        width_request: DOCK_CONSTANTS.SEPARATOR_LINE, height_request: height,
        hexpand: false,
    })

    box.set_center_widget(line)

    const state = {
        targetScale: 1.0, currentScale: 1.0,
        targetWidth: baseWidth, currentWidth: baseWidth,
        targetMargin: 0, currentMargin: 0,
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: true,
        widget: box as Gtk.Widget
    }
    register(id, state)
        ; (box as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return
            state.virtualCenter = v
            state.staticCenter = v
        }

    const target = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE, formats: null })
    target.set_gtypes([GObject.TYPE_STRING])

    target.connect("enter", () => Gdk.DragAction.COPY)

    target.connect("drop", (t, val) => {
        let sourceId = ""
        if (typeof val === "string") sourceId = val
        else if (val && (val as any).get_string) sourceId = (val as unknown as GObject.Value).get_string()

        if (!sourceId || sourceId === "void") return false

        onDrop(sourceId)
        return true
    })
    box.add_controller(target)
    return box
}

// DOCK ITEM COMPONENT
interface DockItemProps {
    appId: string;
    appItem: AstalApps.Application;
    updateDock: () => void;
    register: (id: string, s: any) => void;
    addresses?: string[];
    clientTitle?: string;
    // Callbacks for interaction
    onPin: (id: string) => void;
    onUnpin: (id: string) => void;
    onReorder: (sourceId: string, targetId: string) => void;
    isPinned: boolean;
    cleanId?: string;
}

export function DockItem(
    { appId, appItem, updateDock, register, addresses = [], clientTitle, onPin, onUnpin, onReorder, isPinned, cleanId }: DockItemProps,
    referenceWidget?: Gtk.Widget
) {
    let rawId = "void"
    if (appItem.get_id) {
        rawId = appItem.get_id() || "void"
    } else {
        const key = (appItem as any).id || (appItem as any).icon_name || (appItem as any).name || "void"
        if (Array.isArray(key)) rawId = key[0]
        else if (typeof key === "string") rawId = key
    }
    rawId = rawId.replace(".desktop", "")

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        hexpand: false,
        width_request: DOCK_CONSTANTS.APP_SLOT,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        can_focus: false,
        has_tooltip: false,
    })

    const unsub = dragBus.subscribe((hoverId) => {
        const isTarget = hoverId === appId
        if (isTarget && appItem.name !== "Papelera") {
            itemBox.add_css_class("cd-drag-gap")
        } else {
            itemBox.remove_css_class("cd-drag-gap")
        }
    })
    itemBox.connect("destroy", unsub)

    const iconBox = new Gtk.Box({
        name: "cd-icon-box-" + appId,
        css_classes: ["cd-icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        hexpand: false,
        margin_bottom: 18,
        has_tooltip: false,
    })

    const getIcon = (): { name?: string, path?: string, gicon?: Gio.Icon } => {
        let name: string | string[] = (appItem as any).icon_name || (appItem as any).icon || appItem.name || "application-x-executable"
        let candidate: string | null = null
        try {
            if (Array.isArray(name)) {
                for (const n of name) {
                    const res = appService.getIconName(n)
                    if (res && res !== "image-missing") {
                        candidate = res; break;
                    }
                }
            } else {
                candidate = appService.getIconName(name)
            }
        } catch (e) {
            console.error(`[Dock] getIcon crash for ${(appItem as any).name}:`, e)
        }

        if (candidate) {
            if (candidate.startsWith("/") || candidate.startsWith("file://")) {
                return { path: candidate.replace("file://", "") }
            }
            return { name: candidate }
        }
        if (appItem.get_icon) return { gicon: appItem.get_icon() }
        return { name: "image-missing" }
    }

    const res = getIcon()
    let child: Gtk.Widget

    const iconProps: any = {
        pixel_size: DOCK_CONSTANTS.ICON_SIZE,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    }

    if (res.path) {
        iconProps.gicon = Gio.FileIcon.new(Gio.File.new_for_path(res.path))
    } else if (res.gicon) {
        iconProps.gicon = res.gicon
    } else if (res.name) {
        iconProps.icon_name = res.name
    } else {
        iconProps.icon_name = "image-missing"
    }

    child = new Gtk.Image(iconProps)
    child.set_halign(Gtk.Align.CENTER)
    child.set_valign(Gtk.Align.CENTER)

    const state = {
        targetScale: 1.0, currentScale: 1.0,
        targetWidth: DOCK_CONSTANTS.ICON_SIZE, currentWidth: DOCK_CONSTANTS.ICON_SIZE,
        targetMargin: DOCK_CONSTANTS.BASE_MARGIN, currentMargin: DOCK_CONSTANTS.BASE_MARGIN,
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: false,
        addresses: addresses as string[],
        clientTitle: clientTitle as string | undefined,
        widget: itemBox as Gtk.Widget
    }
    register(appId, state)
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return
            state.virtualCenter = v
            state.staticCenter = v
        }

    const isApp = (!!res.name || !!res.path || !!res.gicon)
    const nameStr = (appItem.name || "").toLowerCase()
    let iconToDisplay: Gtk.Widget = child

    if (isApp) {
        const plate = new Gtk.Box({
            css_classes: ["cd-squircle-plate"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            vexpand: false,
            width_request: DOCK_CONSTANTS.ICON_SIZE,
            height_request: DOCK_CONSTANTS.ICON_SIZE,
        })
        child.set_halign(Gtk.Align.CENTER)
        child.set_valign(Gtk.Align.CENTER)
        child.set_hexpand(true)
        child.set_vexpand(true)

        plate.append(child)
        iconToDisplay = plate
    }

    const isAntigravity = appId.includes("antigravity") || nameStr.includes("antigravity")
    const scaleFactor = isAntigravity ? 0.65 : 0.7
    // @ts-ignore
    child.pixel_size = isApp ? Math.round(DOCK_CONSTANTS.ICON_SIZE * scaleFactor) : DOCK_CONSTANTS.ICON_SIZE
    child.set_name("cd-icon-image-" + appId)
    iconBox.append(iconToDisplay)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], width_request: 4, height_request: 4, has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 4,
        has_tooltip: false,
        width_request: 4, height_request: 4,
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.END,
        vexpand: true,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        has_tooltip: false,
    })
    overlay.set_child(iconBox)
    overlay.add_overlay(indicator)
    itemBox.append(overlay)

    // TOOLTIP
    const tooltip = new Gtk.Popover({ css_classes: ["cd-tooltip"], position: Gtk.PositionType.TOP, autohide: false, has_arrow: false })
    tooltip.set_offset(0, -12)
    const label = new Gtk.Label({ css_classes: ["cd-tooltip-label"] })
    const content = new Gtk.Box({ css_classes: ["cd-tooltip-content"] })
    content.append(label)
    tooltip.set_child(content)

    const updateLabel = () => {
        let targetClient = null
        if (addresses.length > 0) {
            const focused = hypr.focusedClient
            if (focused && addresses.includes(focused.address)) {
                targetClient = focused
            } else {
                targetClient = hypr.clients.find(c => c.address === addresses[0])
            }
        }
        let text = appItem.name || "App"
        if (targetClient && targetClient.title) text = targetClient.title
        else if (clientTitle) text = clientTitle
        label.set_label(text)
    }
    updateLabel()
    tooltip.set_parent(iconBox)

    let tooltipTimeout: number | null = null
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        if (tooltipTimeout) GLib.source_remove(tooltipTimeout)
    })
    motion.connect("motion", (controller, x, y) => {
        itemBox.set_cursor(Gdk.Cursor.new_from_name("pointer", null))
        if (!tooltip.visible && !tooltipTimeout) {
            tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                tooltip.popup(); tooltipTimeout = null; return GLib.SOURCE_REMOVE
            })
        }
    })
    motion.connect("leave", () => {
        itemBox.set_cursor(null)
        if (tooltipTimeout) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        tooltip.popdown()
    })
    iconBox.add_controller(motion)

    // MENU
    const checkId = (cleanId || appId).toLowerCase()
    const popover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
    popover.set_parent(iconBox)

    const toSentenceCase = (str: string) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : ""

    const rebuildMenu = () => {
        const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
        const actions: any[] = []

        actions.push({ label: appItem.name || "App", header: true })
        actions.push({ separator: true })

        let desktopActions: string[] = []
        const gAppInfo = appService.getAppInfo(appId)
        if (gAppInfo && gAppInfo.list_actions) {
            desktopActions = gAppInfo.list_actions()
        }

        if (appId === "launcher") {
            actions.push({ label: "Abrir", action: () => appItem.launch() })
            actions.push({ separator: true })
        } else if (appId === "home-shortcut") {
            actions.push({ label: "Abrir", action: () => appItem.launch() })
            actions.push({ separator: true })
        } else if (appId === "trash") {
            actions.push({ label: "Abrir", action: () => appItem.launch() })
            actions.push({ label: "Vaciar Papelera", action: () => execAsync("gio trash --empty").catch(print) })
            actions.push({ separator: true })
        }

        if (desktopActions.length > 0) {
            desktopActions.forEach((actionName: string) => {
                const rawLabel = actionName
                const label = gAppInfo ? gAppInfo.get_action_name(actionName) : toSentenceCase(rawLabel.replace(/[-_]/g, " "))
                actions.push({
                    label: label,
                    action: () => {
                        try {
                            if (gAppInfo && gAppInfo.launch_action) gAppInfo.launch_action(rawLabel, null)
                        } catch (e) { console.error(e) }
                    }
                })
            })
            actions.push({ separator: true })
        }

        const isSpecialItem = appId === "launcher" || appId === "home-shortcut" || appId === "trash"
        if (!isSpecialItem) {
            actions.push({
                label: isPinned ? "Desanclar del dock" : "Mantener en el dock",
                action: () => {
                    const cid = cleanId || rawId
                    if (isPinned) onUnpin(cid)
                    else onPin(cid)
                }
            })
        }

        if (state.addresses && state.addresses.length > 0) {
            actions.push({ separator: true })
            const winCount = state.addresses.length
            actions.push({
                label: winCount > 1 ? `Cerrar todas (${winCount})` : "Salir",
                isDestructive: true,
                action: () => {
                    state.addresses.forEach(addr => {
                        const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                        execAsync(`hyprctl dispatch closewindow address:${cleanAddr} `).catch(print)
                    })
                }
            })
        }

        actions.forEach(a => {
            if (a.separator) {
                menu.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: ["cd-menu-separator"] }))
            } else if (a.header) {
                const l = new Gtk.Label({ label: a.label, xalign: 0, css_classes: ["cd-menu-header"] })
                menu.append(l)
            } else {
                const b = new Gtk.Button({ label: a.label, css_classes: ["cd-menu-action"] })
                if (a.isDestructive) b.add_css_class("destructive")
                b.connect("clicked", () => { a.action(); popover.popdown() })
                menu.append(b)
            }
        })
        popover.set_child(menu)
    }

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => {
        rebuildMenu()
        try {
            const currentParent = popover.get_parent()
            if (currentParent && currentParent !== iconBox) popover.unparent()
            if (!popover.get_parent()) popover.set_parent(iconBox)
        } catch (e) { }
        popover.popup()
    })
    iconBox.add_controller(rightClick)

    // DRAG SOURCE
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE })
    source.connect("prepare", (s, x, y) => {
        s.set_icon(Gtk.WidgetPaintable.new(child), x, y)
        return Gdk.ContentProvider.new_for_value(cleanId || rawId)
    })
    itemBox.add_controller(source)

    // CLICK (Focus/Launch)
    const leftClick = new Gtk.GestureClick({ button: 1 })
    leftClick.connect("released", () => {
        if (addresses.length > 0) {
            const focusedAddr = hypr.focusedClient?.address
            const idx = addresses.indexOf(focusedAddr || "")
            const nextIdx = (idx + 1) % addresses.length
            let target = addresses[nextIdx]
            if (!target.startsWith("0x")) target = "0x" + target
            try { hypr.dispatch("focuswindow", `address:${target} `) } catch (e) { console.error(e) }
        } else {
            const match = hypr.clients.find(c => {
                const cClass = (c.class || "").toLowerCase()
                const cTitle = (c.initialTitle || "").toLowerCase()
                return cClass === appId || cTitle === appId || cClass.includes(appId)
            })
            if (match) {
                let matchAddr = match.address
                if (!matchAddr.startsWith("0x")) matchAddr = "0x" + matchAddr
                hypr.dispatch("focuswindow", `address:${matchAddr} `)
            } else {
                try { appItem.launch() } catch (e) {
                    execAsync(`gtk-launch ${appId}`).catch(print)
                }
            }
        }
    })
    iconBox.add_controller(leftClick)

    // DROP TARGET
    const acceptDrop = true
    if (acceptDrop) {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE, formats: null })
        target.set_gtypes([GObject.TYPE_STRING])
        target.connect("enter", () => { dragBus.update(appId); return Gdk.DragAction.COPY })
        target.connect("motion", () => { dragBus.update(appId); return Gdk.DragAction.COPY })
        target.connect("leave", () => { /* dragBus.update("") */ })
        target.connect("drop", (t, val) => {
            dragBus.update("")
            let dragId = ""
            if (typeof val === "string") dragId = val
            else if (val && (val as any).get_string) dragId = (val as unknown as GObject.Value).get_string()

            const sourceId = dragId ? dragId.toLowerCase().replace(".desktop", "") : ""
            const targetId = appId.toLowerCase()

            if (!sourceId || sourceId === "void") return false

            // Logic delegated to callbacks
            if (appItem.name === "Papelera" || targetId.includes("user-trash")) {
                onUnpin(sourceId)
                return true
            }
            if (appItem.name === "Angel" || targetId.includes("user-home")) {
                onPin(sourceId)
                return true
            }
            if (sourceId !== targetId) {
                onReorder(sourceId, targetId)
                return true
            }
            return false
        })
        itemBox.add_controller(target)
    }

    // SYNC LOGIC
    const sync = () => {
        const focused = hypr.focusedClient
        const isOpen = addresses.length > 0
        const isFocused = focused && addresses.includes(focused.address)

        if (isOpen) {
            dot.set_visible(true)
            dot.add_css_class("open")
            if (isFocused) dot.add_css_class("focused")
            else dot.remove_css_class("focused")
        } else {
            dot.set_visible(false)
            dot.remove_css_class("open")
            dot.remove_css_class("focused")
        }

        let targetTitle = appItem.name || "App"
        if (focused && addresses.includes(focused.address)) {
            targetTitle = focused.title
        } else if (addresses.length > 0) {
            const c = hypr.clients.find(c => c.address === addresses[0])
            if (c) targetTitle = c.title
        }
        label.set_label(targetTitle || "")
    }

    const c1 = hypr.connect("notify::clients", sync)
    const c2 = hypr.connect("notify::focused-client", sync)

    // V106: PROPER SIGNAL MANAGEMENT
    const clientSignalIds: { client: any, signalId: number }[] = []
    addresses.forEach(addr => {
        const c = hypr.clients.find(cl => cl.address === addr)
        if (c) {
            const signalId = c.connect("notify::title", sync)
            clientSignalIds.push({ client: c, signalId })
        }
    })

    itemBox.connect("destroy", () => {
        hypr.disconnect(c1)
        hypr.disconnect(c2)
        clientSignalIds.forEach(({ client, signalId }) => {
            try { client.disconnect(signalId) } catch (e) { }
        })
    })
    sync()

        ; (itemBox as any).syncState = (newAddrs: string[], newTitle: string | undefined, newAppItem: AstalApps.Application) => {
            state.addresses = newAddrs
            state.clientTitle = newTitle
            appItem = newAppItem // Updates closure reference? No, arguments are copies.
            // Be careful: 'appItem' in closure is bound on creation. 
            // If we update state, we might need a way to refresh everything.
            // Actually, the original code assigned `appItem = newAppItem` inside the syncState function 
            // which was defined inside the main function scope, so it mutated the variable in that scope.
            // Here we also do it, but let's ensure it works.
            // Yes, JS closures allow mutation of outer variables.

            indicator.visible = newAddrs.length > 0
            if (newAddrs.length > 0) {
                itemBox.add_css_class("open")
                const focusedAddr = hypr.focusedClient?.address
                if (focusedAddr && newAddrs.includes(focusedAddr)) itemBox.add_css_class("focused")
                else itemBox.remove_css_class("focused")
            } else {
                itemBox.remove_css_class("open")
                itemBox.remove_css_class("focused")
            }
        }

    return itemBox
}
