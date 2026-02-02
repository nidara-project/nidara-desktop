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
import { getMappedIcon } from "../core/IconMapper"



// Override APP_SLOT calculation if we want perfect math:
// 64 (Icon) + 4 (Margin Start) + 4 (Margin End) = 72px.
// But users are used to 80px density. 
// Let's define default width for Apps as 80 for now.

// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const hypr = AstalHyprland.get_default()
const appsService = new AstalApps.Apps()

// CONSTANT CONFIGURATION (Future: Bind to Settings JSON)
const DOCK_CONFIG = {
    USE_ICON_PLATES: false, // Set to false for themes that already have pre-shaped (squircle/circle) icons
    SMART_PLATES_FOR_FILES: true, // Auto-enable plates for specific file paths    MAX_ICON_SIZE: 160,
    MAGNIFICATION_SCALE: 2.2, // Future-proof param
    HOME_ICON_FALLBACK: ["user-home", "system-file-manager", "folder"],
}

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
        height_request: 92, // V51: Lock height to match Pill
        hexpand: false,
        margin_bottom: 0,  // V95: 10px Gap handled by window margin
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

    // 4. SPECULAR HIGHLIGHT (Glass Edge)
    cr.save()
    cr.translate(0, 1) // 1px Top inset
    path(0)
    cr.clip()

    // @ts-ignore
    const rimGrad = new Cairo.LinearGradient(x, y, x, y + 2)
    rimGrad.addColorStopRGBA(0, 1, 1, 1, 0.75) // More vibrant top edge
    rimGrad.addColorStopRGBA(1, 1, 1, 1, 0.0)

    cr.setSource(rimGrad)
    cr.setLineWidth(2.0)
    cr.stroke()
    cr.restore()

    // 5. M3 RIM LIGHT (Full path definition)
    path()
    cr.setSourceRGBA(1, 1, 1, 0.3)
    cr.setLineWidth(0.7)
    cr.stroke()

    // 6. BOTTOM DEFINITION (Anchor)
    cr.moveTo(x + r, y + drawH)
    cr.lineTo(x + drawW - r, y + drawH)
    cr.setSourceRGBA(0, 0, 0, 0.15)
    cr.setLineWidth(0.5)
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
        height_request: 92, // V70: Constrained to Pill Height to prevent ghost hover
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
        // V98: Perfectly centered in 92px pill (Balanced for 64px icon)
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

    // V94: APPLY MATERIAL ALIASING 💎
    const originalName = res.name || ""
    const appNameStr = appItem.name || ""
    const mapped = getMappedIcon(originalName, appId, appNameStr)

    if (mapped !== originalName) {
        // FORCE Material ONLY for core system tools via ABSOLUTE PATH
        const idLower = appId.toLowerCase()
        const isSystemTool = idLower.includes("pavucontrol") ||
            idLower.includes("rhythmbox") ||
            idLower.includes("distributor-logo") ||
            idLower.includes("wlogout") ||
            idLower.includes("control-center") ||
            idLower.includes("nautilus") ||
            idLower.includes("terminal") ||
            idLower.includes("calculator") ||
            idLower.includes("calendar") ||
            idLower.includes("clocks");

        if (!res.path && !res.gicon) {
            // No better icon, use mapped name
            res.name = mapped
        } else if (isSystemTool) {
            // Force Material theme for system tools by using absolute path
            const materialPath = `/home/angel/.local/share/icons/DistroIA/scalable/apps/${mapped}.svg`
            res.path = materialPath
            res.name = undefined
            res.gicon = undefined
        }
    }

    let child: Gtk.Widget

    // V72: VECTOR-FIRST RENDERING 💎
    // Instead of rasterizing to a fixed 256px Pixbuf (which blurs upon zoom),
    // we use native Gtk.Image properties that allow GTK to reschedule vector drawing at any size.
    const iconProps: any = {
        pixel_size: DOCK_CONSTANTS.ICON_SIZE,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    }

    if (res.path) {
        // High Priority: Manual absolute path (usually for forced system icons)
        iconProps.gicon = Gio.FileIcon.new(Gio.File.new_for_path(res.path))
    } else if (res.gicon) {
        // Medium Priority: Coastal / WebApp embedded icons
        iconProps.gicon = res.gicon
    } else if (res.name) {
        // Low Priority: System themed icon name
        iconProps.icon_name = res.name
    } else {
        iconProps.icon_name = "image-missing"
    }

    child = new Gtk.Image(iconProps)

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

    // V94: MANDATORY PLATING 💎
    // Every item (App or System) gets the white squircle plate.
    const isApp = !state.isSeparator && (!!res.name || !!res.path || !!res.gicon)
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

    // SCALING LOGIC
    const isAntigravity = appId.includes("antigravity") || nameStr.includes("antigravity")
    const scaleFactor = isAntigravity ? 0.65 : 0.7

    // @ts-ignore
    child.pixel_size = isApp ? Math.round(DOCK_CONSTANTS.ICON_SIZE * scaleFactor) : DOCK_CONSTANTS.ICON_SIZE
    // Tooltip / name logic...
    child.set_name("cd-icon-image-" + appId)
    iconBox.append(iconToDisplay)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], width_request: 4, height_request: 4, has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        // V98: Perfectly aligned with centered icon
        margin_bottom: 4,
        has_tooltip: false,
        width_request: 4, height_request: 4, // FIXED SIZE (V11)
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.END, // BOTTOM ANCHOR in 120px container
        vexpand: true,
        height_request: 92, // V98: Locked to Pill height
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
    const content = new Gtk.Box({ css_classes: ["cd-tooltip-content"] })
    content.append(label)
    tooltip.set_child(content)

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

    tooltip.set_parent(iconBox)

    let tooltipTimeout: number | null = null
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        if (tooltipTimeout) GLib.source_remove(tooltipTimeout)
    })
    motion.connect("motion", (controller, x, y) => {
        // NATURAL BOUNDARIES: itemBox is only 92px and sits at the bottom. y=0 is Pill Top.
        itemBox.set_cursor(Gdk.Cursor.new_from_name("pointer", null))

        // Only start timeout if not visible and no timeout pending
        if (!tooltip.visible && !tooltipTimeout) {
            tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                tooltip.popup(); tooltipTimeout = null; return GLib.SOURCE_REMOVE
            })
        }
    })
    motion.connect("leave", () => {
        itemBox.set_cursor(null) // Clean state reset
        if (tooltipTimeout) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        tooltip.popdown()
    })
    // V70.16: TACTILE PRECISION
    // We attach controllers to iconBox, NOT the invisible slot (itemBox).
    // This ensures only the icon graphic captures the heart of the interaction.
    iconBox.add_controller(motion)

    // Interaction: Use cleanId for persistence checks (V35: Strips internal prefixes)
    const checkId = (cleanId || appId).toLowerCase()
    const popover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
    popover.set_parent(iconBox)

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
    rightClick.connect("released", (gesture, n, x, y) => {
        // NO GATE: itemBox is only 92px and situated exactly in the Pill
        rebuildMenu()
        popover.popup()
    })
    iconBox.add_controller(rightClick)

    const leftClick = new Gtk.GestureClick({ button: 1 })
    // HARDENED CLICK LOGIC
    leftClick.connect("released", (gesture, n, x, y) => {
        // NO GATE: iconBox follow icon scale. Perfectly tactile.
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
                console.log(`[DockClick] Launching via appItem.launch(). AppId: ${appId}, Name: ${appItem.name}`);
                try {
                    appItem.launch()
                } catch (e) {
                    console.error(`[DockClick] Launch failed for ${appId}: ${e}`);
                    // Fallback to manual launch if internal launch fails
                    execAsync(`gtk-launch ${appId}`).catch(print)
                }
            }
        }
    })
    iconBox.add_controller(leftClick)


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

            // PINNED ITEM DRAG HANDLING
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
        css_classes: ["crystal-dock"],
        title: "Crystal Dock",
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
        height_request: 92, // V98: Locked to Pill height
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
            let currentFloatX = 0 // V90: Global Continuous Coordinate

            animRegistry.forEach((state, id) => {
                // PHYSICS: Hysteresis & Quantization (V91: Fluid Physics)
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

                // APPLY TO WIDGETS (V90: Global Tiling Engine)
                const widget = widgetCache.get(id)
                if (widget) {
                    const revealer = widget as Gtk.Revealer
                    const itemBox = revealer.get_child() as Gtk.Box

                    // 1. Calculate Float Geometry
                    const floatSlotW = state.currentWidth + (state.currentMargin * 2)
                    const floatIconStart = currentFloatX + state.currentMargin
                    const floatIconEnd = floatIconStart + state.currentWidth
                    const floatSlotEnd = currentFloatX + floatSlotW

                    // 2. Snap to Pixel Grid (Global Snap)
                    const intSlotStart = Math.round(currentFloatX)
                    const intIconStart = Math.round(floatIconStart)
                    const intIconEnd = Math.round(floatIconEnd)
                    const intSlotEnd = Math.round(floatSlotEnd)

                    // 3. Derive Integer Widths & Margins
                    const drawSlotW = intSlotEnd - intSlotStart
                    const drawIconW = intIconEnd - intIconStart
                    const drawMarginS = intIconStart - intSlotStart

                    // Update Global Coordinate
                    currentFloatX = floatSlotEnd

                    // 4. Apply to Layout
                    if (revealer.width_request !== drawSlotW) {
                        revealer.width_request = drawSlotW
                        if (itemBox) itemBox.width_request = drawIconW
                    }
                    if (itemBox) {
                        // V90: Force START alignment to prevent GTK internal rounding jitter
                        if (itemBox.get_halign() !== Gtk.Align.START) itemBox.set_halign(Gtk.Align.START)

                        if (itemBox.margin_start !== drawMarginS) {
                            itemBox.margin_start = drawMarginS
                            itemBox.margin_end = 0 // Margin end is redundant in Tiling
                        }
                    }

                    // 5. The Content (Icon Scale Sync)
                    if (!state.isSeparator) {
                        const overlay = itemBox?.get_first_child() as Gtk.Overlay
                        const iconBox = overlay?.get_child() as Gtk.Box
                        const content = iconBox?.get_first_child() as any
                        const targetPixelSize = Math.round(DOCK_CONSTANTS.ICON_SIZE * state.currentScale)

                        if (content) {
                            // Sync Content Width with Integer Icon Width
                            if (content.get_css_classes().includes("cd-squircle-plate")) {
                                content.set_size_request(drawIconW, targetPixelSize)
                                const icon = content.get_first_child() as any
                                if (icon) {
                                    const iconPath = icon.gicon?.get_file?.()?.get_path() || ""
                                    const isAntigravity = icon.icon_name?.includes("antigravity") || iconPath.includes("antigravity")
                                    const factor = isAntigravity ? 0.65 : 0.7
                                    const internalSize = Math.round(targetPixelSize * factor)
                                    if (icon.pixel_size !== internalSize) {
                                        icon.pixel_size = internalSize
                                        icon.set_size_request(internalSize, internalSize)
                                    }
                                }
                            } else {
                                if (content.pixel_size !== targetPixelSize) {
                                    content.pixel_size = targetPixelSize
                                    content.set_size_request(drawIconW, targetPixelSize)
                                } else {
                                    content.set_size_request(drawIconW, targetPixelSize)
                                }
                            }
                        }
                    }
                }
            })

            // V90: MANUALLY CENTER THE BAR (Prevent 0.5px parity jitter)
            const totalIntWidth = Math.round(currentFloatX)
            const monitorWidth = gdkmonitor.get_geometry().width
            const manualMarginStart = Math.round((monitorWidth - totalIntWidth) / 2)

            if (bar.get_halign() !== Gtk.Align.START) bar.set_halign(Gtk.Align.START)
            if (bar.margin_start !== manualMarginStart) {
                bar.margin_start = manualMarginStart
            }

            // UNIFIED BACKGROUND UPDATE (V90: Global Tiling Sync)
            if (Math.abs(smoothedBarWidth - totalIntWidth) > 0.01) {
                smoothedBarWidth = totalIntWidth // INSTANT FOLLOW
                da.queue_draw()
                updateInputRegion(smoothedBarWidth)
                active = true
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

    let bgAnimId = 0

    // MOTION CONTROLLER
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { /* console.log("Enter Dock") */ })
    const updateInputRegion = (totalWidth: number) => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return

        const monitorWidth = gdkmonitor.get_geometry().width
        const region = new Cairo.Region()
        // Interaction starts at y=98 (Pill top in 200px window).
        // @ts-ignore
        region.unionRectangle({ x: 0, y: 98, width: monitorWidth, height: 92 })
        surface.set_input_region(region)
    }

    win.add_controller(motion) // CRITICAL: RE-ATTACH TO WINDOW
    motion.connect("motion", (controller, x, y) => {
        // V99: Overlap-Aware (Trigger ONLY in active pill area)
        if (y < 98) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(x)
    })
    motion.connect("leave", () => {
        updateAllTargets(-1000)
    })

    // 1. Drawing Area (Background Pill)
    const da = new Gtk.DrawingArea({
        name: "dock-drawing-area",
        css_classes: ["cd-drawing-area"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL,
        height_request: 200, // V99: Tall window for icon overlap
        overflow: Gtk.Overflow.VISIBLE,
        can_focus: false,
    })
    da.set_draw_func((_, cr, w, h) => {
        cr.setOperator(0); cr.paint(); cr.setOperator(2);
        const pillWidth = smoothedBarWidth + 16
        const xOffset = (w - pillWidth) / 2
        const dockHeight = 92
        const yOffset = h - 92 - 10 // V99: 10px from bottom of 200px window
        cr.save()
        cr.translate(xOffset, yOffset)
        drawSquircle(cr, pillWidth, dockHeight)
        cr.restore()
    })

    // 2. Icon Shelf (Shim + Bar)
    const shim = new Gtk.Box({
        valign: Gtk.Align.END, halign: Gtk.Align.START,
        margin_bottom: 10, // V98: 10px Bottom Gap
        height_request: 92,
        vexpand: true,
        overflow: Gtk.Overflow.VISIBLE,
    })
    bar.valign = Gtk.Align.END
    shim.append(bar)

    // 4. Assemble Overlay Stack
    layout.set_child(da)
    layout.add_overlay(shim)


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

            // V94.3: DEEP FALLBACK TO CUSTOM SERVICE 💎
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

        // 0. Static: Launcher (Grid)
        const launcherItem = {
            name: "Lanzador",
            icon_name: "apps",
            launch: () => {
                if ((globalThis as any).toggleAppGrid) {
                    (globalThis as any).toggleAppGrid()
                }
            }
        }
        configs.push({
            id: "launcher", width: 80,
            syncData: { addrs: [], clientTitle: undefined, appItem: launcherItem as any },
            factory: (vc) => {
                const w = DockItem("launcher", launcherItem as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar, "launcher")
                if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                return w
            }
        })

        // 1. Static: Home Shortcut (Smart Resolution)
        const userName = GLib.get_user_name()
        const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

        const resolveHomeIcon = () => {
            for (const name of DOCK_CONFIG.HOME_ICON_FALLBACK) {
                if (appService.getIconName(name)) return name;
            }
            return "user-home";
        }

        const homeItem = {
            name: prettyName,
            icon_name: "home",
            launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(print)
        }
        configs.push({
            id: "home-shortcut", width: 80, // V50: Unified 80px Slot
            syncData: { addrs: [], clientTitle: undefined, appItem: homeItem as any },
            factory: (vc) => {
                const w = DockItem("home-shortcut", homeItem as any, update, (id, s) => animRegistry.set(id, s), [], undefined, bar, "home-shortcut")
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
                const appData = appService.getAppData(lid)
                const displayName = appData?.name || originalId
                const aliases: Record<string, string> = { "system-file-manager": "org.gnome.Nautilus" }
                let icon = aliases[lid] || originalId
                if (lid.startsWith("chrome-") && lid.endsWith("-default")) icon = icon.replace(/-default$/i, "-Default")
                const ghost = { name: displayName, icon_name: icon, launch: getLaunch(lid) } as any
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
                const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), 64) // V68: Taller Separator
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
        totalStaticWidth = configs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)
        const totalWidth = totalStaticWidth

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

        // Initialize Error Accumulators for Sub-pixel Diffusion
        let widthError = 0
        let marginError = 0
        let lastWidget: Gtk.Revealer | null = null

        animRegistry.forEach((state, id) => {
            // V87: INITIALIZATION LOOP (Force Rest State)
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

        if (!tickId) runUnifiedTick() // V87: Ensure tick is running for initialization

        // Call updateAllTargets immediately to set initial state
        updateAllTargets(-1000)

        // Initial setup of tick listener
        runUnifiedTick()

        // Manual Child Sync Algo
        const currentChildren = [] as Gtk.Widget[]
        let child = bar.get_first_child()
        while (child) { currentChildren.push(child); child = child.get_next_sibling() }

        // Remove all current
        currentChildren.forEach(c => bar.remove(c))
        // Append new order
        finalItems.forEach(i => bar.append(i))

        const [_, nat] = bar.get_preferred_size()
        if (nat && nat.width > 10) {
            smoothedBarWidth = nat.width
        } else {
            // Fallback if nat is 0 (unmapped)
            smoothedBarWidth = totalStaticWidth > 0 ? totalStaticWidth : 400
        }

        return bar
    }

    const monitorWidth = gdkmonitor.get_geometry().width
    da.set_size_request(monitorWidth, 200)
    win.set_default_size(monitorWidth, 200)
    win.set_size_request(monitorWidth, 200)

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
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 0); // V99: Internal gap is 10px
        // Initialize input region with current state
        if (animRegistry.size > 0) {
            let total = 0
            for (const s of animRegistry.values()) {
                total += s.currentWidth + (s.currentMargin * 2)
            }
            updateInputRegion(total)
        }

        // V99: 104px EXCLUSIVE ZONE (Ensures windows stop 104px from screen bottom)
        Gtk4LayerShell.set_exclusive_zone(win, 104);

        win.connect("realize", () => {
            const surface = win.get_native()?.get_surface()
            if (surface) {
                const monitorWidth = gdkmonitor.get_geometry().width
                const region = new Cairo.Region()
                // Interaction starts at y=98 (Pill top in 200px window).
                // @ts-ignore
                region.unionRectangle({ x: 0, y: 98, width: monitorWidth, height: 92 })
                surface.set_input_region(region)
            }
        })
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

    win.present()
    return win
}
