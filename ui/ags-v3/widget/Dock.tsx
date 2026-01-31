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
    const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
    // Auto-Sanitization: Dedup and filter paths to prevent ghosts
    pinnedList = [...new Set(raw)].filter(id => !id.startsWith("/"))
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

// 2. SEPARATOR (Now accepts drops to APPEND, with wider hitbox)
// SEPARATOR: Gaussian Horizontal Scaling, Fixed Vertical Height.
function Separator(id: string, updateDock: () => void, register: (id: string, s: any) => void, height = 40) {
    const baseWidth = 48 // Slot: 32 + 16 Gap
    // Container for Hitbox (invisible, wide, fixed height)
    const box = new Gtk.Box({
        css_classes: ["cd-separator-container"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER,
        width_request: 48, // SLOT WIDTH (Match baseWidth)
        height_request: height,
        hexpand: false,
    })

    // Visible Line
    const line = new Gtk.Box({
        name: "cd-separator", css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER,
        width_request: 2, height_request: height,
        hexpand: false, // Strict width
        margin_start: 15, margin_end: 15
    })

    box.append(line)

    // Actually, let's keep it simple: the box can hold a reference to its state
    const state = {
        target: 1.0,
        current: 1.0,
        virtualCenter: 0,
        isSeparator: true,
        update: (scale: number) => {
            box.set_size_request(Math.round(baseWidth * scale), height)
        }
    }
    register(id, state)
        ; (box as any).setVirtualCenter = (v: number) => { state.virtualCenter = v }

    // DROP ON SEPARATOR = APPEND TO LIST
    const target = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE, formats: null })
    target.set_gtypes([GObject.TYPE_STRING]) // Explicit String Type

    target.connect("enter", () => {
        return Gdk.DragAction.COPY
    })

    target.connect("drop", (t, val) => {
        let sourceId = ""
        if (typeof val === "string") sourceId = val
        else if (val && (val as any).get_string) sourceId = (val as unknown as GObject.Value).get_string()

        if (sourceId) sourceId = sourceId.toLowerCase().replace(".desktop", "")
        if (!sourceId || sourceId === "void") return false

        // If already pinned, move to end
        pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
        pinnedList.push(sourceId)
        savePinned(); updateDock(); return true
    })
    box.add_controller(target)
    return box
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

// --- STATE: Pure JS EventBus (No GObject complexity) ---
const dragBus = {
    listeners: [] as ((id: string) => void)[],
    subscribe(fn: (id: string) => void) {
        this.listeners.push(fn)
        return () => { this.listeners = this.listeners.filter(l => l !== fn) }
    },
    update(id: string) {
        console.log(`[DragBus] Update: "${id}"`) // Explicit Log
        this.listeners.forEach(fn => fn(id))
    }
}

// --- DOCK ITEM COMPONENT ---

function DockItem(appId: string, appItem: AstalApps.Application, updateDock: () => void, register: (id: string, s: any) => void, addresses: string[] = [], clientTitle?: string, referenceWidget?: Gtk.Widget) {
    // Preserve case for icon lookups if possible, but use lower for comparison
    const rawId = (appItem.get_id ? appItem.get_id() : (appItem.id || appItem.icon_name || appItem.name || "void")).replace(".desktop", "")

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        hexpand: false,
        width_request: 80, // SLOT WIDTH (Match slotSize)
        height_request: 92,
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        can_focus: false,
        has_tooltip: false,
    })

    // REACTIVE GAP: JS EventBus connection
    const unsub = dragBus.subscribe((hoverId) => {
        // console.log(`[DragBus] Item ${appId} saw ${hoverId}`)
        const isTarget = hoverId === appId
        if (isTarget && appItem.name !== "Papelera") {
            itemBox.add_css_class("cd-drag-gap")
        } else {
            itemBox.remove_css_class("cd-drag-gap")
        }
    })
    itemBox.connect("destroy", unsub)

        // EXPOSE VIRTUAL CENTER UPDATE for Dynamic Grid
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            state.virtualCenter = v
        }

    const iconBox = new Gtk.Box({
        name: "cd-icon-box-" + appId,
        css_classes: ["cd-icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        hexpand: false,
        // Remove fixed width_request to allow icon to push freely
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

    // --- MAGNIFICATION PHYSICS V10 (Unified) ---
    const iconSize = 64
    const slotSize = 80 // Icon (64) + Gap (16)

    const state = {
        target: 1.0,
        current: 1.0,
        virtualCenter: 0,
        isSeparator: false,
        update: (scale: number) => {
            const visualSize = Math.round(iconSize * scale)
            if (child && (child as any).set_pixel_size) (child as any).set_pixel_size(visualSize)
            itemBox.set_size_request(Math.round(slotSize * scale), 92)
        }
    }
    register(appId, state)

        // EXPOSE VIRTUAL CENTER UPDATE
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            state.virtualCenter = v
        }

    // Standard Scaling for all Gtk.Image icons
    // @ts-ignore
    child.pixel_size = 64
    // Tooltip / name logic...
    child.set_name("cd-icon-image-" + appId)
    iconBox.append(child)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], width_request: 4, height_request: 4, has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 4,
        has_tooltip: false,
        width_request: 4, height_request: 4, // FIXED SIZE (V11)
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.END, // BOTTOM ANCHOR (V11)
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

    const actions: any[] = []

    // 1. OPEN
    actions.push({ label: "Abrir", action: () => appItem.launch() })

    // 2. PIN TOGGLE
    actions.push({
        label: isPinned ? "Desanclar" : "Mantener en el Dock",
        action: () => {
            if (isPinned) pinnedList = pinnedList.filter(p => p.toLowerCase() !== appId)
            else pinnedList.push(rawId)
            savePinned(); updateDock()
        }
    })

    // 3. QUIT (If running)
    if (addresses.length > 0) {
        actions.push({ separator: true })
        actions.push({
            label: "Salir",
            action: () => {
                addresses.forEach(addr => {
                    const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                    execAsync(`hyprctl dispatch closewindow address:${cleanAddr}`).catch(print)
                })
            }
        })
    }

    actions.forEach(a => {
        if (a.separator) {
            menu.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: ["cd-menu-separator"] }))
        } else {
            const b = new Gtk.Button({ label: a.label, css_classes: ["cd-menu-action"] })
            b.connect("clicked", () => { a.action(); popover.popdown() })
            menu.append(b)
        }
    })
    popover.set_child(menu)

    // DND Logic: Universal Drag & Drop (MUST BE ADDED FIRST FOR PRIORITY)
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE })
    source.connect("prepare", (s, x, y) => {
        console.log(`[DnD] Prepare Drag: ${appId}`)
        s.set_icon(Gtk.WidgetPaintable.new(child), x, y)
        // Ensure we send a string value
        return Gdk.ContentProvider.new_for_value(appId)
    })
    source.connect("drag-begin", () => console.log(`[DnD] Drag Begin: ${appId}`))
    source.connect("drag-end", () => console.log(`[DnD] Drag End: ${appId}`))
    itemBox.add_controller(source)

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


    // --- DOCK ITEM COMPONENT ---
    // ... (DockItem setup code) ...

    // DND Logic: Universal Drag & Drop (MUST BE ADDED FIRST FOR PRIORITY)
    // ... (Source setup code) ...

    // DROP Logic: On/Around Pinned Items + Static Anchors
    // DROP Logic: Unified Zone A (Apps) + Zone B (Trash)
    const acceptDrop = true

    if (acceptDrop) {
        // Relaxed Formats for reliability - Accept ALL types initially
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE, formats: null })
        target.set_gtypes([GObject.TYPE_STRING]) // removed to allow entry

        // REACTIVE GAP LOGIC
        target.connect("enter", () => {
            console.log(`[DnD] Enter Item: ${appId}`)
            dragBus.update(appId)
            return Gdk.DragAction.COPY
        })
        target.connect("motion", () => {
            dragBus.update(appId)
            return Gdk.DragAction.COPY
        })
        target.connect("leave", () => {
            // dragBus.update("") // Optional: Clear or keep last known?
            // Clearing on leave causes flicker if moving between items quickly
        })
        target.connect("drop", (t, val, x, y) => {
            dragBus.update("") // Clear state immediately

            // ROBUST EXTRACTION
            let dragId = ""
            if (typeof val === "string") {
                dragId = val
            } else if (val && (val as any).get_string) {
                dragId = (val as unknown as GObject.Value).get_string()
            } else {
                console.log(`[DnD] Unknown payload type: ${typeof val}`)
                return false
            }

            console.log(`[DnD] Payload: ${dragId}`)

            const sourceId = dragId ? dragId.toLowerCase().replace(".desktop", "") : ""
            const targetId = appId.toLowerCase()

            if (!sourceId || sourceId === "void") return false

            // TRASH -> UNPIN (Delete)
            if (appItem.name === "Papelera" || targetId.includes("user-trash")) {
                console.log("[DnD] Action: Trash/Unpin")
                const oldLen = pinnedList.length
                pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
                if (pinnedList.length !== oldLen) {
                    savePinned(); updateDock(); return true
                }
                return false
            }

            // FINDER -> PIN START
            if (appItem.name === "Angel" || targetId.includes("user-home")) {
                console.log("[DnD] Action: Pin Start")
                pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
                pinnedList.unshift(sourceId)
                savePinned(); updateDock(); return true
            }

            // PINNED ITEM -> REORDER / INSERT
            if (sourceId !== targetId) {
                console.log("[DnD] Action: Reorder")
                pinnedList = pinnedList.filter(p => p.toLowerCase() !== sourceId)
                let newIdx = pinnedList.findIndex(p => p.toLowerCase() === targetId)
                if (newIdx === -1) {
                    // Target unpinned (Zone A tail) -> Append
                    newIdx = pinnedList.length
                }
                pinnedList.splice(newIdx, 0, sourceId)
                savePinned(); updateDock(); return true
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

// --- MOUSE BUS FOR MAGNIFICATION ---
const mouseBus = {
    listeners: new Set<(x: number) => void>(),
    emit(x: number) { this.listeners.forEach(l => l(x)) },
    subscribe(l: (x: number) => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
}

export default function Dock(gdkmonitor: Gdk.Monitor) {
    console.log("[DISTROIA] Dock() called");
    // CACHE for consistent widget identity & animations
    const widgetCache = new Map<string, Gtk.Widget>()
    const bar = new Gtk.Box({
        name: "the-dock-bar",
        css_classes: ["cd-dock-bar"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: 92,
        spacing: 0, // V7: Total control via widget width_request
        can_focus: false,
    })

    // --- GAUSSIAN V10 UNIFIED ENGINE ---
    type AnimState = { target: number, current: number, update: (val: number) => void, virtualCenter: number }
    const animRegistry = new Map<string, AnimState>()
    let globalAnimId = 0
    let smoothedBarWidth = 200

    const runUnifiedTick = () => {
        if (globalAnimId !== 0) return
        globalAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            let active = false
            animRegistry.forEach((state) => {
                const step = (state.target - state.current) * 0.15
                if (Math.abs(step) > 0.001) {
                    state.current += step
                    state.update(state.current)
                    active = true
                } else if (state.current !== state.target) {
                    state.current = state.target
                    state.update(state.current)
                }
            })

            // Sync Background Width
            const targetWidth = bar.get_allocation().width
            if (targetWidth > 0) {
                const bgStep = (targetWidth - smoothedBarWidth) * 0.15
                if (Math.abs(bgStep) > 0.1) {
                    smoothedBarWidth += bgStep
                    da.queue_draw()
                    active = true
                } else if (smoothedBarWidth !== targetWidth) {
                    smoothedBarWidth = targetWidth
                    da.queue_draw()
                }
            }

            if (!active) {
                globalAnimId = 0
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    const updateAllTargets = (mouseX: number) => {
        animRegistry.forEach((state) => {
            if (mouseX === -1000) {
                state.target = 1.0
            } else {
                const dist = Math.abs(mouseX - state.virtualCenter)
                const maxScale = (state as any).isSeparator ? 1.3 : 1.5
                const sigma = 150 // GAUSSIAN V11: WIDER BELL (Organic)
                const target = 1 + ((maxScale - 1) * Math.exp(-(dist ** 2) / (2 * (sigma ** 2))))
                state.target = target < 1.002 ? 1.0 : target
            }
        })
        runUnifiedTick()
    }
    let bgAnimId = 0

    const startBgAnimation = () => {
        if (bgAnimId !== 0) return
        bgAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const alloc = bar.get_allocation()
            const target = alloc.width > 0 ? alloc.width : smoothedBarWidth
            const step = (target - smoothedBarWidth) * 0.15
            smoothedBarWidth += step
            da.queue_draw()
            if (Math.abs(target - smoothedBarWidth) < 0.1) {
                smoothedBarWidth = target
                da.queue_draw()
                bgAnimId = 0
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    // MOTION CONTROLLER
    // MOTION CONTROLLER - Attached to STATIC Container (Layout), not dynamic Bar
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { /* console.log("Enter Dock") */ })
    motion.connect("motion", (controller, x, y) => {
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        updateAllTargets(-1000)
    })

    // Attach to the layout (Overlay) which is full width
    // Attach to the layout (Overlay) which is full width
    const layout = new Gtk.Overlay({ name: "dock-main-overlay", css_classes: ["cd-main-overlay"], valign: Gtk.Align.FILL, halign: Gtk.Align.FILL, overflow: Gtk.Overflow.VISIBLE })
    layout.add_controller(motion)

    const da = new Gtk.DrawingArea({
        name: "dock-drawing-area",
        css_classes: ["cd-drawing-area"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL, // Full Fill
        height_request: 160,
        overflow: Gtk.Overflow.VISIBLE,
        can_focus: false,
    })
    da.set_draw_func((_, cr, w, h) => {
        cr.setOperator(0); cr.paint(); cr.setOperator(2);

        // DYNAMIC BACKGROUND SIZING (SMOOTHED V9)
        const pillWidth = smoothedBarWidth + 32 // +32px padding

        // Center the pill in the full-width drawing area
        const xOffset = (w - pillWidth) / 2

        const dockHeight = 92
        const yOffset = h - dockHeight

        cr.save()
        cr.translate(xOffset, yOffset) // Move to calculated center
        drawSquircle(cr, pillWidth, dockHeight)
        cr.restore()
    })

    // WRAPPER: Force vertical stability
    const shim = new Gtk.Box({
        valign: Gtk.Align.END, halign: Gtk.Align.CENTER,
        height_request: 92, // STRICT HEIGHT
        overflow: Gtk.Overflow.VISIBLE,
        css_classes: ["cd-dock-shim"],
    })
    // Bar inside shim
    // bar.valign = CENTER ensures that if bar grows (visual), it grows from center of 92px shim
    bar.valign = Gtk.Align.CENTER
    shim.append(bar)

    layout.set_child(da); layout.add_overlay(shim)

    const mainContainer = new Gtk.Box({
        name: "dock-main-container", css_classes: ["cd-dock-container"],
        valign: Gtk.Align.FILL, halign: Gtk.Align.FILL,
        hexpand: true, vexpand: false, can_focus: false
    })
    mainContainer.append(layout)

    const update = () => {
        // VIRTUAL GRID REFACTOR: Collection Phase
        type ItemConfig = { id: string, width: number, factory: (vc: number) => Gtk.Widget }
        const configs: ItemConfig[] = []
        const currentIds = new Set<string>()

        // Helper to get/create widget (Used later in instantiation phase)
        const getOrCreateItem = (id: string, factory: () => Gtk.Widget) => {
            currentIds.add(id)
            if (widgetCache.has(id)) {
                return widgetCache.get(id)!
            }
            const widget = factory()
            // Wrap in revealer
            const revealer = new Gtk.Revealer({
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

        // 1. Group Running Clients
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
            return app
        }

        const getLaunch = (lid: string) => {
            const app = appService.getAppData(lid)
            const desktopId = app?.id || lid
            return () => execAsync(`gtk-launch ${desktopId}`).catch(print)
        }

        // 0. Static: Finder
        const userName = GLib.get_user_name()
        const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)
        const finder = {
            name: prettyName,
            icon_name: "user-home",
            launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(print)
        }
        configs.push({
            id: "finder", width: 80,
            factory: (vc) => {
                const w = DockItem("finder", finder as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar)
                if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                return w
            }
        })

        // 2. Process Pinned List
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
            }

            if (appItem) {
                if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                    // @ts-ignore
                    appItem.icon_name = originalId.replace(/-default$/i, "-Default")
                }
                configs.push({
                    id: "pinned-" + lid, width: 80,
                    factory: (vc) => {
                        const w = DockItem(lid, appItem!, update, (id, s) => animRegistry.set(id, s), addrs, clientTitle, bar)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            } else {
                const aliases: Record<string, string> = { "system-file-manager": "org.gnome.Nautilus" }
                let icon = aliases[lid] || originalId
                if (lid.startsWith("chrome-") && lid.endsWith("-default")) icon = icon.replace(/-default$/i, "-Default")
                const ghost = { name: originalId, icon_name: icon, launch: getLaunch(lid) } as any
                configs.push({
                    id: "pinned-ghost-" + lid, width: 80,
                    factory: (vc) => {
                        const w = DockItem(lid, ghost, update, (id, s) => animRegistry.set(id, s), [], undefined, bar)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            }
        })

        // 3. Running Apps (Unpinned)
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
                appItem.icon_name = appItem.icon_name.replace(/-default$/i, "-Default")
            }
            configs.push({
                id: "running-" + lid, width: 80,
                factory: (vc) => {
                    const w = DockItem(lid, appItem!, update, (id, s) => animRegistry.set(id, s), group.addresses, group.title, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })
        })

        // 4. Separator & Trash
        configs.push({
            id: "sep-trash", width: 48,
            factory: (vc) => {
                const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), 40)
                if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                return w
            }
        })

        const trash = {
            name: "Papelera",
            icon_name: "user-trash",
            launch: () => execAsync("nautilus trash:///").catch(print)
        }
        configs.push({
            id: "trash", width: 80,
            factory: (vc) => {
                const w = DockItem("trash", trash as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar)
                if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                return w
            }
        })

        // VIRTUAL GRID V7: Slot-Based Calculation
        const count = configs.length
        const totalWidth = configs.reduce((sum, c) => sum + c.width, 0)

        const screenWidth = gdkmonitor.get_geometry().width
        const startX = (screenWidth - totalWidth) / 2

        let currentX = startX
        const finalItems = configs.map((c) => {
            const myCenter = currentX + (c.width / 2)
            currentX += c.width

            const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
            const inner = (widget as Gtk.Revealer).get_child()
            if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)
            return widget
        })

        // Diff & Prune Cache
        for (const [id, w] of widgetCache) {
            if (!currentIds.has(id)) {
                widgetCache.delete(id)
            }
        }

        // Manual Child Sync Algo
        const currentChildren = [] as Gtk.Widget[]
        let child = bar.get_first_child()
        while (child) { currentChildren.push(child); child = child.get_next_sibling() }

        // Remove all current
        currentChildren.forEach(c => bar.remove(c))
        // Append new order
        finalItems.forEach(i => bar.append(i))

        const [_, nat] = bar.get_preferred_size()
        if (nat) {
            const monitorWidth = gdkmonitor.get_geometry().width
            // EXPANSION: Layout is now full width to allow Magnification overflow
            const w = monitorWidth
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
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true);
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true);
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 10);
        Gtk4LayerShell.set_exclusive_zone(win, 112); // ZONE = 10 (Gap) + 92 (Docker) + 10 (Window Gap)
    } catch (e) { console.error(e) }

    const cConn = hypr.connect("notify::clients", update)
    const aConn = appService.connect(update)
    bar.connect("destroy", () => {
        hypr.disconnect(cConn)
        aConn() // Disconnect manual callback
    })

    // Initial update + Safety delay for appsService to populate
    update()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { update(); return GLib.SOURCE_REMOVE })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => { update(); return GLib.SOURCE_REMOVE })

    return win
}
