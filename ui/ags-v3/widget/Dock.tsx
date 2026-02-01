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
import { calculateDockItemMetrics, DOCK_CONSTANTS } from "./DockPhysics"



// Override APP_SLOT calculation if we want perfect math:
// 64 (Icon) + 4 (Margin Start) + 4 (Margin End) = 72px.
// But users are used to 80px density. 
// Let's define default width for Apps as 80 for now.

// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const hypr = AstalHyprland.get_default()
const appsService = new AstalApps.Apps()

let pinnedList: string[] = []
try {
    const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
    // V34: TOTAL SANITY - Dedup, filter paths, and STRIP ALL LEGACY PREFIXES
    const oldLen = raw.length
    pinnedList = [...new Set(raw)]
        .filter(id => id && !id.startsWith("/"))
        .map(id => id.replace(/^pinned-/, "").replace(/^pinned-ghost-/, "").replace(/^running-/, ""))

    // V36: If we cleaned something, save it back to disk immediately
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

import appService from "../core/AppService"

// --- DOCK ITEM COMPONENT ---

// --- UI HELPERS ---

// 2. SEPARATOR (Now accepts drops to APPEND, with wider hitbox)
// SEPARATOR: Gaussian Horizontal Scaling, Fixed Vertical Height.
function Separator(id: string, updateDock: () => void, register: (id: string, s: any) => void, height = 48) {
    const baseWidth = DOCK_CONSTANTS.SEPARATOR_SLOT
    // Container for Hitbox (invisible, wide, fixed height)
    const box = new Gtk.Box({
        css_classes: ["cd-separator-container"],
        valign: Gtk.Align.END, halign: Gtk.Align.CENTER,
        width_request: baseWidth,
        height_request: 92, // V51: Lock height to prevent vertical jitter
        hexpand: false,
    })

    // Visible Line
    const line = new Gtk.Box({
        name: "cd-separator", css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.START, // V54.10: Force START + Margin to ensure position
        width_request: DOCK_CONSTANTS.SEPARATOR_LINE, height_request: height,
        hexpand: false,
        margin_start: DOCK_CONSTANTS.SEPARATOR_OFFSET
    })

    box.append(line)

    // Actually, let's keep it simple: the box can hold a reference to its state
    const state = {
        targetScale: 1.0, currentScale: 1.0,
        targetWidth: baseWidth, currentWidth: baseWidth,
        targetMargin: 0, currentMargin: 0,
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: true
    }
    register(id, state)
        // EXPOSE VIRTUAL CENTER UPDATE
        ; (box as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return // V51: Sub-pixel lock
            state.virtualCenter = v
            state.staticCenter = v
        }

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

        // V34: No prefixes to strip, IDs are already clean
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

function DockItem(appId: string, appItem: AstalApps.Application, updateDock: () => void, register: (id: string, s: any) => void, addresses: string[] = [], clientTitle?: string, referenceWidget?: Gtk.Widget, cleanId?: string) {
    // Preserve case for icon lookups if possible, but use lower for comparison
    const rawId = (appItem.get_id ? appItem.get_id() : (appItem.id || appItem.icon_name || appItem.name || "void")).replace(".desktop", "")

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        hexpand: false,
        width_request: DOCK_CONSTANTS.APP_SLOT, // SLOT (V14 Master)
        height_request: 160,
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        can_focus: false,
        has_tooltip: false,
    })

    // REACTIVE GAP: JS EventBus connection
    const unsub = dragBus.subscribe((hoverId) => {
        // console.log(`[DragBus] Item ${ appId } saw ${ hoverId } `)
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

    // V67: UNIVERSAL HIGH-RES TEXTURE STABILIZER 💎
    // Force ALL icons (theme or file) into a high-res Pixbuf (256px).
    // This prevents GTK from swapping to low-res or "symbolic" versions during the wave.
    try {
        let pixbuf: GdkPixbuf.Pixbuf | null = null
        if (res.path) {
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(res.path, 256, 256, true)
        } else if (res.name || res.gicon) {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
            let iconPaintable: any = null
            if (res.name) {
                iconPaintable = theme.lookup_icon(res.name, [], 256, 1, Gtk.TextDirection.NONE, 0)
            } else if (res.gicon) {
                // @ts-ignore
                iconPaintable = theme.lookup_by_gicon(res.gicon, 256, 1, Gtk.TextDirection.NONE, 0)
            }

            if (iconPaintable) {
                // We use Gtk.Image.new_from_paintable to keep it as a stable texture
                child = Gtk.Image.new_from_paintable(iconPaintable)
            } else {
                child = Gtk.Image.new_from_icon_name("image-missing")
            }
        } else {
            child = Gtk.Image.new_from_icon_name("image-missing")
        }

        if (pixbuf) {
            child = Gtk.Image.new_from_pixbuf(pixbuf)
        }
    } catch (e) {
        console.warn(`[Dock] Icon resolution failed for ${appId}:`, e)
        child = Gtk.Image.new_from_icon_name("image-missing")
    }

    // V61: UNIVERSAL CENTERING (Fix for Antigravity & All Icons)
    // Force center alignment for ALL icon types to prevent sub-pixel jitter.
    // Previously this was only applied to 'path' icons, but AppService maps Antigravity to 'name'.
    child.set_halign(Gtk.Align.CENTER)
    child.set_valign(Gtk.Align.CENTER)


    // --- MAGNIFICATION PHYSICS V14 (Master) ---
    const iconSize = DOCK_CONSTANTS.ICON_SIZE
    const slotSize = DOCK_CONSTANTS.APP_SLOT // Base Slot (V14 Master)

    const state = {
        targetScale: 1.0, currentScale: 1.0,
        targetWidth: DOCK_CONSTANTS.ICON_SIZE, currentWidth: DOCK_CONSTANTS.ICON_SIZE, // V50: Stable Physical Base
        targetMargin: DOCK_CONSTANTS.BASE_MARGIN, currentMargin: DOCK_CONSTANTS.BASE_MARGIN, // V55: Polished Margin
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: false,
        addresses: addresses as string[], // V39
        clientTitle: clientTitle as string | undefined // V39
    }
    register(appId, state)

        // EXPOSE VIRTUAL CENTER UPDATE
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return // V51: Sub-pixel lock
            state.virtualCenter = v
            state.staticCenter = v
        }

    // V66.3: APPLE-STYLE ICON PLATE (Squircle) - FINAL ROBUST VERSION
    // Exclude system items (Trash, Finder, Nautilus, Separator) from the white background.
    const systemExclusions = [
        "papelera", "home", "files", "archivo", "nautilus", "thunar", "dolphin",
        "org.gnome.nautilus", "separator", "finder"
    ]
    const nameStr = (appItem.name || "").toLowerCase()
    const idStr = appId.toLowerCase()
    const isApp = !!(appItem.icon_name || appItem.get_icon) &&
        !systemExclusions.some(ex => nameStr.includes(ex) || idStr.includes(ex))

    let iconToDisplay: Gtk.Widget = child

    if (isApp) {
        const plate = new Gtk.Box({
            css_classes: ["cd-squircle-plate"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            vexpand: false,
        })
        plate.append(child)
        // Set initial symmetric margins
        const m = Math.round(DOCK_CONSTANTS.ICON_SIZE * 0.15)
        child.set_margin_start(m); child.set_margin_end(m)
        child.set_margin_top(m); child.set_margin_bottom(m)
        iconToDisplay = plate
    }

    // @ts-ignore
    child.pixel_size = isApp ? (DOCK_CONSTANTS.ICON_SIZE - (2 * Math.round(DOCK_CONSTANTS.ICON_SIZE * 0.15))) : DOCK_CONSTANTS.ICON_SIZE
    // Tooltip / name logic...
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
        width_request: 4, height_request: 4, // FIXED SIZE (V11)
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.END, // BOTTOM ANCHOR
        vexpand: true,
        height_request: 160,
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

    // Interaction: Use cleanId for persistence checks (V35: Strips internal prefixes)
    const checkId = (cleanId || appId).toLowerCase()
    const popover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
    popover.set_parent(itemBox)

    const toSentenceCase = (str: string) => {
        if (!str) return ""
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
    }

    const rebuildMenu = () => {
        // V39: Recalculate isPinned and active status every time the menu is shown
        const currentIsPinned = pinnedList.some(p => p.toLowerCase() === checkId)

        const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
        const actions: any[] = []

        // 1. HEADER (App Name)
        actions.push({ label: appItem.name || "App", header: true })
        actions.push({ separator: true })

        // 2. DESKTOP ACTIONS (Quick Actions)
        let desktopActions: string[] = []
        // @ts-ignore
        if (appItem && appItem.list_actions) desktopActions = appItem.list_actions()
        // @ts-ignore
        else if (appItem && appItem.app && appItem.app.list_actions) desktopActions = appItem.app.list_actions()

        if (desktopActions.length > 0) {
            desktopActions.forEach((actionName: string) => {
                // Determine label: For raw GAppInfo, we map action ID -> Sentence Case
                const rawLabel = actionName
                // Format: Sentence case (replace - and _ with space)
                const label = toSentenceCase(rawLabel.replace(/[-_]/g, " "))

                actions.push({
                    label: label,
                    action: () => {
                        console.log(`[DockMenu] Launching action: ${rawLabel}`)
                        // Try standard launch_action
                        if (appItem.launch_action) appItem.launch_action(rawLabel)
                        // @ts-ignore
                        else if (appItem && appItem.app && appItem.app.launch_action) appItem.app.launch_action(rawLabel)
                    }
                })
            })
            actions.push({ separator: true })
        }
        // 3. SYSTEM ACTIONS
        actions.push({ label: "Abrir nueva ventana", action: () => appItem.launch() })

        actions.push({
            label: currentIsPinned ? "Desanclar del dock" : "Mantener en el dock",
            action: () => {
                const cid = cleanId || rawId
                if (currentIsPinned) pinnedList = pinnedList.filter(p => p.toLowerCase() !== cid.toLowerCase())
                else pinnedList.push(cid)
                savePinned(); updateDock()
            }
        })

        // 4. WINDOW MANAGEMENT (If running)
        if (state.addresses && state.addresses.length > 0) {
            actions.push({ separator: true })

            // If multiple windows, maybe show count?
            const winCount = state.addresses.length
            if (winCount > 1) {
                actions.push({
                    label: `Cerrar todas (${winCount})`, isDestructive: true,
                    action: () => {
                        state.addresses.forEach(addr => {
                            const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                            execAsync(`hyprctl dispatch closewindow address:${cleanAddr} `).catch(print)
                        })
                    }
                })
            } else {
                actions.push({
                    label: "Salir", isDestructive: true,
                    action: () => {
                        state.addresses.forEach(addr => {
                            const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                            execAsync(`hyprctl dispatch closewindow address:${cleanAddr} `).catch(print)
                        })
                    }
                })
            }
        }

        actions.forEach(a => {
            if (a.separator) {
                menu.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: ["cd-menu-separator"] }))
            } else if (a.header) { // V53: Header style
                const l = new Gtk.Label({ label: a.label, xalign: 0, css_classes: ["cd-menu-header"] })
                menu.append(l)
            } else {
                const b = new Gtk.Button({ label: a.label, css_classes: ["cd-menu-action"] })
                if (a.isDestructive) b.add_css_class("destructive") // Add red style
                b.connect("clicked", () => { a.action(); popover.popdown() })
                menu.append(b)
            }
        })
        popover.set_child(menu)
    }

    // DND Logic: Universal Drag & Drop (MUST BE ADDED FIRST FOR PRIORITY)
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE })
    source.connect("prepare", (s, x, y) => {
        console.log(`[DnD] Prepare Drag: ${appId} `)
        s.set_icon(Gtk.WidgetPaintable.new(child), x, y)
        // V35: Send cleanId (pre-sanitized raw app name) to prevent prefix leakage
        return Gdk.ContentProvider.new_for_value(cleanId || rawId)
    })
    source.connect("drag-begin", () => console.log(`[DnD] Drag Begin: ${appId} `))
    source.connect("drag-end", () => console.log(`[DnD] Drag End: ${appId} `))
    itemBox.add_controller(source)

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => {
        rebuildMenu()
        popover.popup()
    })
    itemBox.add_controller(rightClick)

    const leftClick = new Gtk.GestureClick({ button: 1 })
    // HARDENED CLICK LOGIC
    leftClick.connect("released", () => {
        console.log(`[DockClick] Clicked ${appId}.Addresses in scope: ${addresses.length} `);

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
                hypr.dispatch("focuswindow", `address:${target} `)
                // OPTIONAL: Workspace switch backup if focuswindow fails to swap WS
                // const client = hypr.clients.find(c => c.address === target)
                // if (client) hypr.dispatch("workspace", `${ client.workspace.id } `)
            } catch (e) {
                console.error(`[DockClick] Dispatch failed: ${e} `)
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
                console.log(`[DockClick] Found logic match: ${matchAddr} `);
                hypr.dispatch("focuswindow", `address:${matchAddr} `)
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
            console.log(`[DnD] Enter Item: ${appId} `)
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
                console.log(`[DnD] Unknown payload type: ${typeof val} `)
                return false
            }

            console.log(`[DnD] Payload: ${dragId} `)

            // V34: Clean IDs, direct comparison
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

        // V39: Expose state sync for reused widgets
        ; (itemBox as any).syncState = (newAddrs: string[], newTitle: string | undefined, newAppItem: AstalApps.Application) => {
            state.addresses = newAddrs
            state.clientTitle = newTitle
            appItem = newAppItem
            indicator.visible = newAddrs.length > 0
        }

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
    console.log("[DISTROIA] Dock() initializing (Anti-Jitter Widget Edition)");
    // CACHE for consistent widget identity & animations
    const widgetCache = new Map<string, Gtk.Widget>()
    const bar = new Gtk.Box({
        name: "the-dock-bar",
        css_classes: ["cd-dock-bar"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: 160, // UNLEASH HEIGHT (V15)
        spacing: 0, // V7: Total control via widget width_request
        can_focus: false,
    })

    // --- V17 PHYSICS ENGINE ---
    type AnimState = {
        targetScale: number, currentScale: number,
        targetWidth: number, currentWidth: number,
        targetMargin: number, currentMargin: number,
        virtualCenter: number, staticCenter: number, isSeparator: boolean
    }
    const animRegistry = new Map<string, AnimState>()
    let globalAnimId = 0
    let smoothedBarWidth = 200

    const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor

    let tickId: number | null = null

    const runUnifiedTick = () => {
        if (tickId !== null) return

        tickId = bar.add_tick_callback((_, clock) => {
            let active = false
            let sumWidths = 0

            animRegistry.forEach((state, id) => {
                // PHYSICS: Hysteresis & Quantization (V27 Anti-Jitter)
                const scaleDiff = Math.abs(state.targetScale - state.currentScale)
                if (scaleDiff > 0.0001) {
                    state.currentScale = lerp(state.currentScale, state.targetScale, 0.25)
                    active = true
                } else state.currentScale = state.targetScale

                const widthDiff = Math.abs(state.targetWidth - state.currentWidth)
                if (widthDiff > 0.01) {
                    state.currentWidth = lerp(state.currentWidth, state.targetWidth, 0.25)
                    active = true
                } else state.currentWidth = state.targetWidth

                const marginDiff = Math.abs(state.targetMargin - state.currentMargin)
                if (marginDiff > 0.01) {
                    state.currentMargin = lerp(state.currentMargin, state.targetMargin, 0.25)
                    active = true
                } else state.currentMargin = state.targetMargin

                // APPLY TO WIDGETS
                const widget = widgetCache.get(id)
                if (widget) {
                    // 1. The Container (Slot)
                    const revealer = widget as Gtk.Revealer
                    const itemBox = revealer.get_child() as Gtk.Box

                    // Width & Dynamic Margins (Rounded for GTK but cached to avoid redundant calls)
                    const w = Math.round(state.currentWidth)
                    const m = Math.round(state.currentMargin)

                    if (revealer.width_request !== w) {
                        revealer.width_request = w
                        if (itemBox) itemBox.width_request = w
                    }
                    if (itemBox && itemBox.margin_start !== m) {
                        itemBox.margin_start = m
                        itemBox.margin_end = m
                    }

                    // 2. The Content (Icon Scale)
                    if (!state.isSeparator) {
                        // Find icon inside structure of boxes
                        // itemBox -> overlay -> iconBox -> child
                        // We need a cleaner way to update icon size. Using the update callback was cleaner.
                        // Let's re-implement a manual update or keep a ref.
                        // Ideally we traverse:
                        // DockItem has `update` callback, but now state is pure data.

                        // HACK: We can find the icon by name convention or traverse.
                        // Or better: Restore the `update` callback slightly to just handle the icon pixel size?
                        // Actually, let's just use CSS scale or find the child.
                        // The user said: "Icon Visual: transform: scale(scale)." -> CSS transform is better but GTK4 CSS transform is tricky.
                        // Let's stick to pixel_size for now as it worked.

                        // We need to access the Gtk.Image.
                        // Known structure: itemBox -> Overlay -> Box (icon-box) -> Image
                        const overlay = itemBox?.get_first_child() as Gtk.Overlay
                        const iconBox = overlay?.get_child() as Gtk.Box
                        const content = iconBox?.get_first_child() as any
                        const targetPixelSize = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)

                        if (content) {
                            // V66.3: Hierarchical Scaling (Radius + Symmetry)
                            if (content.get_css_classes().includes("cd-squircle-plate")) {
                                content.set_size_request(targetPixelSize, targetPixelSize)

                                const icon = content.get_first_child() as any
                                if (icon) {
                                    // V66.3: Integer-Perfect Margins
                                    const im = Math.round(targetPixelSize * 0.15)
                                    const internalSize = targetPixelSize - (2 * im)

                                    if (icon.pixel_size !== internalSize) {
                                        icon.pixel_size = internalSize
                                    }
                                    icon.set_margin_start(im); icon.set_margin_end(im)
                                    icon.set_margin_top(im); icon.set_margin_bottom(im)
                                }
                            } else {
                                if (content.pixel_size !== targetPixelSize) content.pixel_size = targetPixelSize
                            }
                        }
                    }
                }
                // SYNC SUM (V57: Derivation)
                sumWidths += state.currentWidth + (state.currentMargin * 2)
            })

            // UNIFIED BACKGROUND UPDATE (V57: 1:1 Synchronization)
            // sumWidths is already derived from 'currentWidth' (which is Lerped).
            // We must NOT Lerp again, or the background lags behind the icons.
            const totalTargetPillWidth = sumWidths

            if (Math.abs(smoothedBarWidth - totalTargetPillWidth) > 0.01) {
                smoothedBarWidth = totalTargetPillWidth // INSTANT FOLLOW
                da.queue_draw()
                active = true // Keep loop alive if widths are changing
            }

            if (!active) {
                tickId = null
                return false // STOP TICK
            }
            return true // CONTINUE TICK
        })
    }

    let lastMouseX = -1000
    const updateAllTargets = (mouseX: number) => {
        // V56: Raw Input (No Deadzone, No Quantization)
        // Removed 1.5px deadzone and 0.5px rounding for ultra-smooth response.
        lastMouseX = mouseX
        const qX = mouseX

        animRegistry.forEach((state) => {
            if (qX === -1000) {
                // RESET
                state.targetScale = 1.0
                if (state.isSeparator) {
                    state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.targetMargin = 0 // V54: Sync with Physics 32px
                } else {
                    state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.targetMargin = DOCK_CONSTANTS.BASE_MARGIN // V55: Clean Reset
                }
            } else {
                const metrics = calculateDockItemMetrics(
                    qX,
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

    let bgAnimId = 0

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

        // DYNAMIC BACKGROUND SIZING (V52: Unified 16px gaps)
        const pillWidth = smoothedBarWidth + 16 // 8px per side (8px pill + 8px icon margin = 16px gap)

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
        height_request: 160, // ALLOW UPWARD GROWTH (V12)
        overflow: Gtk.Overflow.VISIBLE,
        css_classes: ["cd-dock-shim"],
    })
    // Bar inside shim
    bar.valign = Gtk.Align.END
    shim.append(bar)

    layout.set_child(da);

    // V58: Input Shield (Must be added BEFORE shim to be underneath)
    // This catches motion in the 'gaps' so the cursor doesn't fall through to the desktop.
    const inputShield = new Gtk.Box({ css_classes: ["cd-input-shield"] })
    layout.add_overlay(inputShield) // Layer 1 (Shield)

    layout.add_overlay(shim) // Layer 2 (Icons/Bar)

    const mainContainer = new Gtk.Box({
        name: "dock-main-container", css_classes: ["cd-dock-container"],
        valign: Gtk.Align.FILL, halign: Gtk.Align.FILL,
        hexpand: true, vexpand: false, can_focus: false
    })
    mainContainer.append(layout) // RESTORED VITAL CONNECTION


    const update = () => {

        // VIRTUAL GRID REFACTOR: Collection Phase
        type ItemConfig = { id: string, width: number, syncData?: any, factory: (vc: number) => Gtk.Widget }
        const configs: ItemConfig[] = []
        // removed bad log
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
            return () => execAsync(`gtk - launch ${desktopId} `).catch(print)
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
            id: "finder", width: 80, // V50: Unified 80px Slot
            syncData: { addrs: [], clientTitle: undefined, appItem: finder as any },
            factory: (vc) => {
                const w = DockItem("finder", finder as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar, "finder")
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
                    id: lid, width: 80, // V50: Unified 80px Slot
                    syncData: { addrs, clientTitle, appItem: appItem! },
                    factory: (vc) => {
                        const w = DockItem(lid, appItem!, update, (id, s) => animRegistry.set(id, s), addrs, clientTitle, bar, lid)
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
                    id: lid, width: 80, // V50: Unified 80px Slot
                    syncData: { addrs: [], clientTitle: undefined, appItem: ghost },
                    factory: (vc) => {
                        const w = DockItem(lid, ghost, update, (id, s) => animRegistry.set(id, s), [], undefined, bar, lid)
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
                id: lid, width: 80, // V50: Unified 80px Slot
                syncData: { addrs: group.addresses, clientTitle: group.title, appItem: appItem! },
                factory: (vc) => {
                    const w = DockItem(lid, appItem!, update, (id, s) => animRegistry.set(id, s), group.addresses, group.title, bar, lid)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })
        })

        // 4. Separator & Trash
        configs.push({
            id: "sep-trash", width: DOCK_CONSTANTS.SEPARATOR_SLOT,
            syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
            factory: (vc) => {
                const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), 48)
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
            id: "trash", width: 80, // V50: Unified 80px Slot
            syncData: { addrs: [], clientTitle: undefined, appItem: trash as any },
            factory: (vc) => {
                const w = DockItem("trash", trash as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar, "trash")
                if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                return w
            }
        })

        // VIRTUAL GRID V7: Slot-Based Calculation
        const count = configs.length
        // VIRTUAL GRID V55: Variable Geometry Calculation (Polished)
        // We sum specific widths instead of count * Constants
        const totalWidth = configs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)

        const screenWidth = gdkmonitor.get_geometry().width
        const startX = (screenWidth - totalWidth) / 2

        let currentX = startX
        const finalItems = configs.map((c) => {
            const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT // V55: Consistent Polished Slot
            const myCenter = currentX + (slotWidth / 2)
            currentX += slotWidth

            const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
            const inner = (widget as Gtk.Revealer).get_child()
            if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)

            // V39: REFRESH STATE for reused widgets (Crucial for context menu labels)
            if (inner && (inner as any).syncState && (c as any).syncData) {
                const d = (c as any).syncData
                    ; (inner as any).syncState(d.addrs, d.clientTitle, d.appItem)
            }
            return widget
        })

        // Diff & Prune Cache (V34: Unified Purge for Zero-Ghosting)
        for (const [id, w] of widgetCache) {
            if (!currentIds.has(id)) {
                widgetCache.delete(id)
                animRegistry.delete(id)
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
