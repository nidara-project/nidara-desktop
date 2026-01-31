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

// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const hypr = AstalHyprland.get_default()
const appsService = new AstalApps.Apps()

let pinnedList: string[] = []
try {
    pinnedList = JSON.parse(readFile(PINNED_FILE)) as string[]
} catch {
    pinnedList = []
}

const savePinned = () => {
    console.log(`[Dock] Saving pinned list: ${JSON.stringify(pinnedList)}`);
    writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
}

import appService from "../core/AppService"

// --- DOCK ITEM COMPONENT ---

// --- UI HELPERS ---

function Separator() {
    return new Gtk.Box({
        name: "cd-separator",
        css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        has_tooltip: false, // NUCLEAR
    })
}

const drawSquircle = (cr: any, width: number, height: number, targetW?: number) => {
    if (width <= 0 || height <= 0) return

    // CLEAR BUFFER
    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // SAFE MARGINS
    const marginY = 0
    const marginX = 12
    const drawH = height - (marginY * 2)
    const drawW = (targetW || width)
    const x = (width - drawW) / 2
    const y = marginY

    const r = drawH * 0.44
    const n = 3.2

    cr.setAntialias(3)
    const path = (d = 0) => {
        const rd = Math.max(0, r + d)
        cr.newPath()
        cr.moveTo(x + r, y - d)
        cr.lineTo(x + drawW - r, y - d)

        // Top-right
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + drawW - r + px, y + r - py)
        }
        // Bottom-right
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + drawW - r + px, y + drawH - r + py)
        }

        cr.lineTo(x + r, y + drawH + d)

        // Bottom-left
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + drawH - r + py)
        }
        // Top-left
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + r - py)
        }
        cr.closePath()
    }

    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // 1. CLEAN OUTER SHADOW
    cr.save()
    cr.rectangle(0, 0, width, height)
    path()
    cr.setFillRule(1)
    cr.clip()

    cr.save()
    cr.translate(0, 4)
    path(4)
    cr.setSourceRGBA(0, 0, 0, 0.04)
    cr.fill()
    cr.restore()
    cr.restore()

    // 2. SPLIT DEFINITION BORDER
    cr.newPath()
    cr.moveTo(x, y + drawH / 2)
    cr.lineTo(x, y + drawH - r)
    for (let i = 0; i <= 64; i++) {
        let t = (i / 64) * (Math.PI / 2)
        cr.lineTo(x + r - (r * Math.pow(Math.abs(Math.cos(t)), 2 / n)), y + drawH - r + (r * Math.pow(Math.abs(Math.sin(t)), 2 / n)))
    }
    cr.lineTo(x + drawW - r, y + drawH)
    for (let i = 64; i >= 0; i--) {
        let t = (i / 64) * (Math.PI / 2)
        cr.lineTo(x + drawW - r + (r * Math.pow(Math.abs(Math.cos(t)), 2 / n)), y + drawH - r + (r * Math.pow(Math.abs(Math.sin(t)), 2 / n)))
    }
    cr.lineTo(x + drawW, y + drawH / 2)
    cr.setSourceRGBA(0, 0, 0, 0.08)
    cr.setLineWidth(1)
    cr.stroke()

    // 3. MAIN BACKGROUND FILL
    // @ts-ignore
    const gradient = new Cairo.LinearGradient(x, y, x, y + drawH)
    gradient.addColorStopRGBA(0, 1, 1, 1, 0.22)
    gradient.addColorStopRGBA(1, 1, 1, 1, 0.14)
    path()
    cr.setSource(gradient)
    cr.fill()

    // 4. SPECULAR HIGHLIGHT
    cr.save()
    cr.translate(0, 1) // 1px Top inset
    path(0)
    cr.clip()

    // @ts-ignore
    const rimGrad = new Cairo.LinearGradient(x, y, x, y + 4)
    rimGrad.addColorStopRGBA(0, 1, 1, 1, 0.55)
    rimGrad.addColorStopRGBA(1, 1, 1, 1, 0.0)

    cr.setSource(rimGrad)
    cr.setLineWidth(1.5)
    cr.stroke()
    cr.restore()

    // 5. M3 RIM LIGHT 
    path()
    cr.setSourceRGBA(1, 1, 1, 0.25)
    cr.setLineWidth(0.6)
    cr.stroke()
}

// --- DOCK ITEM COMPONENT ---

function DockItem(appItem: AstalApps.Application, updateDock: () => void, addresses: string[] = [], clientTitle?: string) {
    // Preserve case for icon lookups if possible, but use lower for comparison
    const rawId = (appItem.get_id ? appItem.get_id() : (appItem.id || appItem.icon_name || appItem.name || "void")).replace(".desktop", "")
    const appId = rawId.toLowerCase()

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        hexpand: false,
        width_request: 64, // Capped width
        height_request: 92,
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        can_focus: false,
        has_tooltip: false,
    })

    const iconBox = new Gtk.Box({
        name: "cd-icon-box-" + appId,
        css_classes: ["cd-icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        hexpand: false,
        width_request: 64, // Capped width
        margin_bottom: 14,
        has_tooltip: false,
    })

    // ICON LOGIC: High-Reliability Path Resolution from Pre-resolved SSOT Service
    // ICON LOGIC: High-Reliability Resolution from SSOT Service
    const getIcon = (): { name?: string, path?: string, gicon?: Gio.Icon } => {
        let name = appItem.icon_name || appItem.name || "application-x-executable"

        const candidate = appService.getIconName(name)
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

    if (res.name) {
        child = Gtk.Image.new_from_icon_name(res.name)
    } else if (res.path) {
        const file = Gio.File.new_for_path(res.path)
        child = Gtk.Image.new_from_gicon(Gio.FileIcon.new(file))
    } else if (res.gicon) {
        child = Gtk.Image.new_from_gicon(res.gicon)
    } else {
        child = Gtk.Image.new_from_icon_name("image-missing")
    }

    // Standard Scaling for all Gtk.Image icons
    // @ts-ignore
    child.pixel_size = 64
    // Tooltip / name logic...
    child.set_name("cd-icon-image-" + appId)
    iconBox.append(child)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 5,
        has_tooltip: false,
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.FILL,
        vexpand: true,
        has_tooltip: false,
    })
    overlay.set_child(iconBox)
    overlay.add_overlay(indicator)
    itemBox.append(overlay)

    // Tooltip Logic
    const tooltip = new Gtk.Popover({ css_classes: ["cd-tooltip"], position: Gtk.PositionType.TOP, autohide: false, has_arrow: false })
    tooltip.set_offset(0, -12)
    // PREFER CLIENT TITLE for Tooltip (Dynamic)
    const label = new Gtk.Label({ css_classes: ["cd-tooltip-label"] })

    // BINDING LOGIC
    // We want the title of the *focused* instance if active, or the first instance otherwise.
    // Since we can't easily complex-bind in vanilla Gtk logic here without Reactive, 
    // we'll set initial text and try to hook a signal if possible, or reliance on polling/update.

    // Actually, update() is called on notify::clients. 
    // Title changes usually trigger notify::client on Hyprland service? 
    // Let's try to bind if we can find the specific client object.

    const updateLabel = () => {
        // Find the "active" client among addresses
        let targetClient = null
        if (addresses.length > 0) {
            const focused = hypr.focusedClient
            if (focused && addresses.includes(focused.address)) {
                targetClient = focused
            } else {
                // Find first match in clients list (expensive but accurate)
                targetClient = hypr.clients.find(c => c.address === addresses[0])
            }
        }

        let text = appItem.name || "App"
        if (targetClient && targetClient.title) text = targetClient.title
        else if (clientTitle) text = clientTitle

        label.set_label(text)
    }

    updateLabel()

    // Hook into hypr events just for this item? No, that's too heavy.
    // Instead, trust that the parent `update()` recreates us or we need a specific signal.
    // If update() is not called on title change, it means `dock.update()` isn't firing on title change.
    // WE NEED TO ADD listeners for title changes.

    const content = new Gtk.Box({ css_classes: ["cd-tooltip-content"] })
    content.append(label)
    tooltip.set_child(content)
    tooltip.set_parent(itemBox)

    let tooltipTimeout: number | null = null
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        if (tooltipTimeout) GLib.source_remove(tooltipTimeout)
        tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            tooltip.popup(); tooltipTimeout = null; return GLib.SOURCE_REMOVE
        })
    })
    motion.connect("leave", () => {
        if (tooltipTimeout) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        tooltip.popdown()
    })
    itemBox.add_controller(motion)

    // Interaction
    const isPinned = pinnedList.some(p => p.toLowerCase() === appId)
    const popover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
    popover.set_parent(itemBox)
    const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })

    const actions = [
        { label: "Nuevo Ventana", action: () => appItem.launch() },
        {
            label: isPinned ? "Desanclar" : "Anclar", action: () => {
                if (isPinned) pinnedList = pinnedList.filter(p => p.toLowerCase() !== appId)
                else pinnedList.push(rawId) // SAVE PRESERVED ID
                savePinned(); updateDock()
            }
        }
    ]
    actions.forEach(a => {
        const b = new Gtk.Button({ label: a.label, css_classes: ["cd-menu-action"] })
        b.connect("clicked", () => { a.action(); popover.popdown() })
        menu.append(b)
    })
    popover.set_child(menu)

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => popover.popup())
    itemBox.add_controller(rightClick)

    const leftClick = new Gtk.GestureClick({ button: 1 })
    // HARDENED CLICK LOGIC
    leftClick.connect("released", () => {
        console.log(`[DockClick] Clicked ${appId}. Addresses in scope: ${addresses.length}`);

        // 1. Refresh active addresses from Hyprland source of truth if possible
        // (For now relying on 'addresses' prop, assuming update() runs on client open/close)

        if (addresses.length > 0) {
            // CYCLING LOGIC
            const focusedAddr = hypr.focusedClient?.address
            const idx = addresses.indexOf(focusedAddr || "")
            // If active, go to next. If not active, go to first.
            const nextIdx = (idx + 1) % addresses.length
            let target = addresses[nextIdx]

            // Hyprland requires 0x prefix for address dispatch
            if (!target.startsWith("0x")) target = "0x" + target

            console.log(`[DockClick] Cycling to: ${target} (current: ${focusedAddr})`);
            try {
                // FORCE FOCUS
                hypr.dispatch("focuswindow", `address:${target}`)
                // OPTIONAL: Workspace switch backup if focuswindow fails to swap WS
                // const client = hypr.clients.find(c => c.address === target)
                // if (client) hypr.dispatch("workspace", `${client.workspace.id}`)
            } catch (e) {
                console.error(`[DockClick] Dispatch failed: ${e}`)
            }
        } else {
            console.log(`[DockClick] Launching or finding match for ${appId}`);
            const match = hypr.clients.find(c => {
                const cClass = (c.class || "").toLowerCase()
                const cTitle = (c.initialTitle || "").toLowerCase()
                return cClass === appId || cTitle === appId || cClass.includes(appId)
            })
            if (match) {
                let matchAddr = match.address
                if (!matchAddr.startsWith("0x")) matchAddr = "0x" + matchAddr
                console.log(`[DockClick] Found logic match: ${matchAddr}`);
                hypr.dispatch("focuswindow", `address:${matchAddr}`)
            }
            else {
                console.log(`[DockClick] Launching via appItem.launch()`);
                appItem.launch()
            }
        }
    })
    itemBox.add_controller(leftClick)

    // DND Logic
    if (isPinned) {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
        source.connect("prepare", (s, x, y) => {
            s.set_icon(Gtk.WidgetPaintable.new(child), x, y)
            return Gdk.ContentProvider.new_for_value(appId)
        })
        itemBox.add_controller(source)

        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE, formats: Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING) })
        target.connect("drop", (t, val, x, y) => {
            const dragId = (val as unknown as GObject.Value).get_string()
            const targetId = appId.toLowerCase()
            const sourceId = dragId ? dragId.toLowerCase() : ""

            if (sourceId && sourceId !== targetId) {
                const oldIdx = pinnedList.findIndex(p => p.toLowerCase() === sourceId)
                const newIdx = pinnedList.findIndex(p => p.toLowerCase() === targetId)

                if (oldIdx !== -1 && newIdx !== -1) {
                    const [moved] = pinnedList.splice(oldIdx, 1)
                    pinnedList.splice(newIdx, 0, moved)
                    savePinned()
                    updateDock()
                    return true
                }
            }
            return false
        })
        itemBox.add_controller(target)
    }

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

        // Update tooltip text dynamically
        // Optimized: only look for focused if it matches us, else first instance
        let targetTitle = appItem.name || "App"
        if (focused && addresses.includes(focused.address)) {
            targetTitle = focused.title
        } else if (addresses.length > 0) {
            // Fallback to first client we can find
            const c = hypr.clients.find(c => c.address === addresses[0])
            if (c) targetTitle = c.title
        }
        label.set_label(targetTitle)
    }
    const c1 = hypr.connect("notify::clients", sync)
    const c2 = hypr.connect("notify::focused-client", sync)

    // REACTIVITY FOR TITLES: Connect to 'notify::title' on all relevant clients
    // We need to keep track of these connections to disconnect them
    const clientSignals: number[] = []
    const refreshSignals = () => {
        // Clear old
        // Note: we can't easily clear signal handlers on specific GObjects we don't hold ref to nicely 
        // without keeping the object.
        // BUT, since DockItem is destroyed and recreated on list updates, 
        // we might be leaking if we don't handle this carefully or if we do standard partial updates.
        // Actually Dock updates recreate all items currently (brute force). 
        // So we just need to connect on init and disconnect on destroy.

        addresses.forEach(addr => {
            const client = hypr.clients.find(c => c.address === addr)
            if (client) {
                // @ts-ignore
                const id = client.connect("notify::title", sync)
                // We need to store client + id to disconnect? 
                // Client object might be ephemeral in bindings? 
                // ASTAL usually keeps singletons. Let's assume safely we need to manage this.
                // However, doing this cleanly inside a functional component without hooks is tricky.

                // Hack: Just re-running sync on focused-client change handles the active window title case
                // IF Hyprland notifies focused-client change when title changes? (Unlikely).

                // Let's try connecting to the *active* client specifically if possible
            }
        })
    }

    // Better strategy: Just listen to 'urgent' or global events? 
    // Or simply: 
    // The user says "doesn't update". 
    // Let's try connecting sync to 'notify::active-window' on Hyprlans if accessible?
    // No.

    // Let's loop addresses and connect to signals.
    /* 
       We will store the objects to disconnect later.
    */
    const monitoredClients: any[] = []
    addresses.forEach(addr => {
        const c = hypr.clients.find(cl => cl.address === addr)
        if (c) {
            monitoredClients.push(c)
            c.connect("notify::title", sync)
        }
    })

    itemBox.connect("destroy", () => {
        hypr.disconnect(c1);
        hypr.disconnect(c2);
        // Clean up client signals? 
        // GObject signals are usually auto-disconnected when the *handler* (this closure) dies? 
        // No, when the *emitter* or *object* dies. 
        // We SHOULD disconnect manually.
        monitoredClients.forEach(c => GObject.signal_handlers_disconnect_by_func(c, sync))
    })
    sync()

    return itemBox
}

// --- MAIN DOCK ---

export default function Dock(gdkmonitor: Gdk.Monitor) {
    console.log("[DISTROIA] Dock() called");
    const bar = new Gtk.Box({
        name: "the-dock-bar",
        css_classes: ["cd-dock-bar"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: 92,
        spacing: 16,
        can_focus: false,
    })
    const da = new Gtk.DrawingArea({
        name: "dock-drawing-area",
        css_classes: ["cd-drawing-area"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.CENTER,
        height_request: 160,
        overflow: Gtk.Overflow.VISIBLE,
        can_focus: false,
    })
    da.set_draw_func((_, cr, w, h) => {
        cr.setOperator(0); cr.paint(); cr.setOperator(2);
        const dockHeight = 92
        const yOffset = h - dockHeight
        cr.save()
        cr.translate(0, yOffset)
        drawSquircle(cr, w, dockHeight)
        cr.restore()
    })

    const layout = new Gtk.Overlay({ name: "dock-main-overlay", css_classes: ["cd-main-overlay"], valign: Gtk.Align.FILL, halign: Gtk.Align.CENTER, overflow: Gtk.Overflow.VISIBLE })
    layout.set_child(da); layout.add_overlay(bar)

    const mainContainer = new Gtk.Box({ name: "dock-main-container", css_classes: ["cd-dock-container"], valign: Gtk.Align.FILL, halign: Gtk.Align.CENTER, hexpand: false, vexpand: false, can_focus: false })
    mainContainer.append(layout)

    const update = () => {
        const items: Gtk.Widget[] = []

        // 1. Group Running Clients by Class
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
            const aliases: Record<string, string> = {
                "system-file-manager": "org.gnome.Nautilus",
                "antigravity": "antigravity"
            }
            const lid = searchId.toLowerCase().replace(".desktop", "")
            const targetId = aliases[lid] || searchId
            const tlid = targetId.toLowerCase().replace(".desktop", "")

            // Precise match in registry (lid-to-lid)
            let app = appsService.list.find(a => {
                const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase().replace(".desktop", "")
                return aid === tlid
            })
            // Fuzzy fallback (handles class-to-desktop)
            if (!app) app = appsService.fuzzy_query(targetId)?.[0]
            return app
        }

        const desktopMap: { [key: string]: string } = {
            "gnome-terminal-server": "org.gnome.Terminal",
            "org.gnome.nautilus": "org.gnome.Nautilus",
            "nautilus": "org.gnome.Nautilus",
            "org.gnome.settings": "org.gnome.Settings",
            "antigravity": "antigravity",
            "system-file-manager": "org.gnome.Nautilus"
        }
        const groupMap: { [key: string]: string } = {
            "system-file-manager": "org.gnome.nautilus",
            "antigravity": "antigravity"
        }

        const getLaunch = (lid: string) => {
            if (lid === "antigravity") {
                return () => execAsync(`bash -c "unset LD_PRELOAD; /usr/share/antigravity/antigravity &"`).catch(print)
            }
            const desktopId = desktopMap[lid] || lid
            return () => execAsync(`gtk-launch ${desktopId}`).catch(print)
        }

        // 2. Process Pinned List
        pinnedList.filter(id => !!id).forEach(id => {
            const lid = id.toLowerCase().replace(".desktop", "")
            const originalId = id.replace(".desktop", "")

            let appItem = findApp(id)

            // Antigravity Override (System Necessity)
            if (lid === "antigravity") {
                appItem = {
                    ...(appItem || {}),
                    name: "Antigravity",
                    icon_name: "/usr/share/pixmaps/antigravity.png",
                    launch: getLaunch(lid)
                } as any
            }

            // Match with running group
            const targetKey = groupMap[lid] || lid
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
            }

            if (appItem) {
                // PWA CASING CORRECTION: Force -Default suffix as it's the standard for Chrome icons
                if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                    // @ts-ignore
                    appItem.icon_name = originalId.replace(/-default$/i, "-Default")
                }

                items.push(DockItem(appItem, update, addrs, clientTitle))
            } else {
                // Ghost fallback
                const aliases: Record<string, string> = { "system-file-manager": "org.gnome.Nautilus" }
                let icon = aliases[lid] || originalId

                if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                    icon = icon.replace(/-default$/i, "-Default")
                }

                console.log(`[DockTrace] Ghost: ${id} -> Icon: ${icon}`);
                const ghost = {
                    name: originalId,
                    icon_name: icon,
                    launch: getLaunch(lid)
                } as any
                items.push(DockItem(ghost, update, []))
            }
        })

        // 3. Separator and Remaining Running Apps
        const runKeys = Object.keys(groupedClients)
        if (runKeys.length > 0 && items.length > 0) items.push(Separator())

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
                appItem.icon_name = appItem.icon_name.replace(/-default$/i, "-Default")
            }

            items.push(DockItem(appItem, update, group.addresses, group.title))
        })

        // Sync with bar
        let child = bar.get_first_child()
        while (child) { const n = child.get_next_sibling(); bar.remove(child); child = n }
        items.forEach(i => bar.append(i))

        const [_, nat] = bar.get_preferred_size()
        if (nat) {
            const monitorWidth = gdkmonitor.get_geometry().width
            const w = Math.min(Math.ceil(nat.width) + 48, monitorWidth * 0.95)
            da.set_size_request(w, 160)
            if (win) { win.set_default_size(w, 160); win.set_size_request(w, 160) }
        }
    }

    const win = (
        <window
            name="crystal-dock"
            namespace="crystal-dock"
            css_classes={["crystal-dock"]}
            gdkmonitor={gdkmonitor}
            application={app}
            visible={true}
            decorated={false}
            heightRequest={160}
            hasTooltip={false}>
            {mainContainer}
        </window>
    ) as any as Gtk.Window

    // --- HARDWARE TRANSPARENCY & BLUR SYNC ---
    try {
        // @ts-ignore
        win.app_paintable = true
        // @ts-ignore
        win.input_shape_combine_region(null)
    } catch (e) { }

    win.set_decorated(false)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "crystal-dock");
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY);
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 10); // PHYSICAL GAP
        Gtk4LayerShell.set_exclusive_zone(win, 112); // ZONE = 10 (Gap) + 92 (Docker) + 10 (Window Gap)
    } catch (e) { console.error(e) }

    const cConn = hypr.connect("notify::clients", update)
    const aConn = appsService.connect("notify::list", update)
    bar.connect("destroy", () => {
        hypr.disconnect(cConn)
        appsService.disconnect(aConn)
    })

    // Initial update + Safety delay for appsService to populate
    update()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { update(); return GLib.SOURCE_REMOVE })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => { update(); return GLib.SOURCE_REMOVE })

    return win
}
