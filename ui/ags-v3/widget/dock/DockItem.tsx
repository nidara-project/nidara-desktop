import { Astal, Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import Cairo from "gi://cairo"
import appService from "../../core/AppService" // Ensure import path is correct relative to this file
import { DOCK_CONSTANTS } from "./DockPhysics"
import { drawSquircle, createSquirclePath } from "../common/DrawingUtils"
import { dragBus, mouseBus } from "./state"

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

// --- STATE: Removed local dragBus (now using shared state from ./state) ---

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
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: baseWidth, currentWidth: baseWidth, velocityWidth: 0,
        targetMargin: 0, currentMargin: 0, velocityMargin: 0,
        targetHeight: height, currentHeight: height, velocityHeight: 0,
        targetTranslateY: 0, currentTranslateY: 0, velocityY: 0,
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

    // V540: REDUNDANT DROP TARGET REMOVED. Consolidated in global handler.
    return box
}

// DOCK ITEM COMPONENT
interface DockItemProps {
    appId: string;
    appItem: any;
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
    props: DockItemProps,
    referenceWidget?: Gtk.Widget
) {
    let { appId, appItem, updateDock, register, addresses = [], clientTitle, onPin, onUnpin, onReorder, isPinned, cleanId } = props
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
        halign: Gtk.Align.START,
        hexpand: false,
        width_request: DOCK_CONSTANTS.ICON_SIZE,
        height_request: DOCK_CONSTANTS.PILL_HEIGHT,
        can_focus: false,
        focusable: false, // V405: Explicitly disable focus
        has_tooltip: false,
    })

    // V457: Live reordering handler for visual states
    const unsub = dragBus.subscribe((draggingId, hoverId) => {
        const isDraggingMe = draggingId === appId || draggingId === cleanId
        if (isDraggingMe) {
            itemBox.add_css_class("cd-dragging")
        } else {
            itemBox.remove_css_class("cd-dragging")
        }
    })
    itemBox.connect("destroy", unsub)

    const iconBox = new Gtk.Box({
        name: "cd-icon-box-" + appId,
        css_classes: ["cd-icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        hexpand: false,
        margin_bottom: 24, // 🛡️ V141: Increased margin for 120px PILL_HEIGHT
        has_tooltip: false,
        can_focus: false, // V405: Explicitly disable focus
        focusable: false
    })

    const getIcon = (): { name?: string, path?: string, gicon?: any } => {
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

    // HEURISTIC: Is this a themed icon or a full-frame external icon?
    // We will finalize this after resolving the path for system icons.
    let isThemed = true


    // V132: Custom DrawingArea for Pixel-Perfect Scaling (Zero Popping / Zero Layout Shift)
    let pixbuf: any = null
    let resolvedPath = res.path || ""
    const sourceSize = 128 // Load high-res once

    try {
        if (res.path) {
            pixbuf = (GdkPixbuf as any).Pixbuf.new_from_file_at_scale(res.path, sourceSize, sourceSize, true)
        } else if (res.name) {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
            if (theme.has_icon(res.name)) {
                const info = theme.lookup_icon(res.name, [], sourceSize, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_REGULAR)
                if (info) {
                    const file = info.get_file()
                    if (file && file.get_path()) {
                        resolvedPath = file.get_path()!
                        pixbuf = (GdkPixbuf as any).Pixbuf.new_from_file_at_scale(resolvedPath, sourceSize, sourceSize, true)
                    }
                }
            }
        } else if (res.gicon) {
            const gicon = res.gicon as any
            if (gicon.get_file && gicon.get_file()) {
                resolvedPath = gicon.get_file()!.get_path() || ""
                if (resolvedPath) pixbuf = (GdkPixbuf as any).Pixbuf.new_from_file_at_scale(resolvedPath, sourceSize, sourceSize, true)
            }
        }
    } catch (e) {
        // console.error(`[DockItem] Failed to load pixbuf for ${appId}:`, e)
    }

    // Finalize Heuristic: Check the resolved path to see if it's truly external
    isThemed = (resolvedPath.includes("/usr/share/icons") || resolvedPath.includes(".local/share/icons"))
        && !resolvedPath.includes("hicolor")
        && !resolvedPath.includes("branding")
        && !resolvedPath.includes("antigravity")
        && !appId.includes("antigravity")


    if (pixbuf) {
        // Custom Drawing
        child = new Gtk.DrawingArea()
        child.set_valign(Gtk.Align.CENTER)
        child.set_halign(Gtk.Align.CENTER)
            // Explicitly cast to any because TS definitions for Gtk4 DrawingArea might be incomplete in this environment
            ; (child as any).set_content_width(DOCK_CONSTANTS.ICON_SIZE)
            ; (child as any).set_content_height(DOCK_CONSTANTS.ICON_SIZE)

            ; (child as any).set_draw_func((area: any, cr: any, w: number, h: number) => {
                if (!pixbuf) return

                // Full-frame icons (Antigravity) use factor 0.95 for a slight "Safe Inset"
                // Themed icons (Chrome) keep factor 0.8 to preserve their internal design
                const factor = isThemed ? 0.8 : 0.95 // 🛡️ V142: 95% scaling for full-frame to ensure no edge bleed

                // Calculate available size including padding
                const availW = w * factor
                const availH = h * factor

                // Native aspect ratio
                const iconW = pixbuf.get_width()
                const iconH = pixbuf.get_height()

                // Scale to fit available padded area
                const scaleX = availW / iconW
                const scaleY = availH / iconH
                // Scale strategy: 'Contain' for themed icons, 'Cover' for full-frame to ensure zero gaps
                const scale = isThemed ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY)

                // Center in the FULL widget area (w, h)
                const drawW = iconW * scale
                const drawH = iconH * scale
                const x = (w - drawW) / 2
                const y = (h - drawH) / 2

                cr.save()

                // V135: Apply Squircle Clipping for full-frame icons
                // V143: Sync radius with factor 0.5 (Full Squircle) for sizing parity
                if (!isThemed) {
                    createSquirclePath(cr, 0, 0, w, h, w * 0.5, 3.2, false, 0)
                    cr.clip()
                }

                cr.translate(x, y)
                cr.scale(scale, scale)

                Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
                cr.paint()
                cr.restore()

                // V136: Universal Apple-Style Glassy Highlight (Refined: Inset 1px)
                cr.save()
                // Inset by 0.5px so 1.0px stroke stays perfectly within bounds
                // V144: Sync radius with 0.5 to match background plate
                createSquirclePath(cr, 0.5, 0.5, w - 1, h - 1, (w * 0.5) - 0.5, 3.2, false, 0)

                const highlightPat = new Cairo.LinearGradient(0, 0, 0, h)
                // TOP: Glassy White Highlight (Refined)
                highlightPat.addColorStopRGBA(0, 1, 1, 1, 0.45)
                highlightPat.addColorStopRGBA(0.4, 1, 1, 1, 0.05)

                // MID: Transparent
                highlightPat.addColorStopRGBA(0.5, 1, 1, 1, 0.0)

                // BOTTOM: Subtle White Rim (Apple style)
                highlightPat.addColorStopRGBA(1, 1, 1, 1, 0.15)

                cr.setLineWidth(1.0)
                cr.setSource(highlightPat)
                cr.stroke()
                cr.restore()
            })
    } else {
        // Fallback for system icons
        const iconProps: any = {
            icon_name: res.name || "image-missing",
            pixel_size: 128,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER
        }
        child = new Gtk.Image(iconProps)
        child.set_size_request(DOCK_CONSTANTS.ICON_SIZE, DOCK_CONSTANTS.ICON_SIZE)
    }

    // Common props
    child.set_halign(Gtk.Align.CENTER)
    child.set_valign(Gtk.Align.CENTER)
    // Removed override: child.set_size_request(..., ...) - Size is handled by DrawingArea setup or Plate logic

    const state = {
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: DOCK_CONSTANTS.ICON_SIZE, currentWidth: DOCK_CONSTANTS.ICON_SIZE, velocityWidth: 0,
        targetMargin: DOCK_CONSTANTS.BASE_MARGIN, currentMargin: DOCK_CONSTANTS.BASE_MARGIN, velocityMargin: 0,
        targetHeight: DOCK_CONSTANTS.PILL_HEIGHT, currentHeight: DOCK_CONSTANTS.PILL_HEIGHT, velocityHeight: 0,
        targetTranslateY: 0, currentTranslateY: 0, velocityY: 0,
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
    // V410: Lift plate variable scope for manual bg control
    let plate: Gtk.Widget | null = null

    if (isApp) {
        // V412: THE NUCLEAR OPTION
        // We replace Gtk.Box with Gtk.DrawingArea for the background plate.
        // A DrawingArea has NO internal CSS nodes, NO ripple gadgets, and NO focus rings.
        // It is just raw pixels. This explicitly kills the "Ghost Ripple/Glow".
        const da = new Gtk.DrawingArea({
            css_classes: ["cd-squircle-plate-drawing"],
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: false,
            vexpand: false,
            width_request: DOCK_CONSTANTS.ICON_SIZE,
            height_request: DOCK_CONSTANTS.ICON_SIZE,
            can_focus: false,
            focusable: false
        })

        const PLATE_OPACITY = 0.9 // V414: Tweakable opacity (lower = more blur visible)

        da.set_draw_func((_, cr, w, h) => {
            // V145: ALWAYS draw the glassy plate to ensure visual weight parity.
            // Even if the icon is full-frame, having the plate ensures consistency in magnification limits.

            // V413: Use shared drawSquircle for consistent geometry
            // V430: Enable Gloss/Border effect
            drawSquircle(cr, w, h, undefined, PLATE_OPACITY, true)
        })

        plate = da

        // Container Architecture: Overlay [Background=DA, Foreground=Icon]
        const plateOverlay = new Gtk.Overlay({
            css_classes: ["cd-plate-container"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        })
        plateOverlay.set_child(da)

        // Center the icon strictly
        child.set_valign(Gtk.Align.CENTER)
        child.set_halign(Gtk.Align.CENTER)
        child.set_size_request(DOCK_CONSTANTS.ICON_SIZE, DOCK_CONSTANTS.ICON_SIZE)

        plateOverlay.add_overlay(child)
        iconToDisplay = plateOverlay
    }

    const isAntigravity = appId.includes("antigravity") || nameStr.includes("antigravity")

    child.set_name("cd-icon-image-" + appId)
    iconBox.append(iconToDisplay)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], width_request: 5, height_request: 5, has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 4,
        has_tooltip: false,
        width_request: 5, height_request: 5,
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
    const tooltip = new Gtk.Popover({ css_classes: ["cd-tooltip"], position: Gtk.PositionType.TOP, autohide: false, has_arrow: true })
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
        // Removed: itemBox.set_cursor(Gdk.Cursor.new_from_name("pointer", null))
        if (popover && popover.visible) return // Don't show tooltip if menu is open

        if (!tooltip.visible && !tooltipTimeout) {
            tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                tooltip.popup(); tooltipTimeout = null; return GLib.SOURCE_REMOVE
            })
        }
    })
    motion.connect("leave", () => {
        // V411: Reverted manual BG toggle (user requires always visible)
        // if (plate) plate.remove_css_class("show-bg")
        if (tooltipTimeout) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        tooltip.popdown()
    })
    iconBox.add_controller(motion)

    // MENU
    // V406: Lazy Popover Creation to prevent startup artifacts
    let popover: Gtk.Popover | null = null

    const createPopover = () => {
        if (popover) return popover

        console.log(`[Dock] Creating Lazy Popover for ${appId}`)
        const newPopover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
        newPopover.set_parent(iconBox)
        newPopover.connect("notify::visible", () => {
            (globalThis as any).isAnyMenuOpen = newPopover.visible
            console.error(`[DockMenu] Popover visible change: ${newPopover.visible} for ${appId}`)
        })
        popover = newPopover
        return newPopover
    }

    const toSentenceCase = (str: string) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : ""

    const rebuildMenu = () => {
        const p = createPopover()
        if (p.visible) {
            console.error(`[DockMenu] Skip rebuild for ${appId} - already visible`)
            return
        }
        console.error(`[DockMenu] Rebuilding menu for: ${appId}`)

        const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
        const actions: any[] = []

        actions.push({ label: appItem.name || "App", header: true })
        actions.push({ separator: true })

        let desktopActions: string[] = []
        const gAppInfo = appService.getAppInfo(appId)
        if (gAppInfo && gAppInfo.list_actions) {
            desktopActions = gAppInfo.list_actions()
        }

        if (appId === "launcher" || appId === "special:launcher") {
            actions.push({ label: "Abrir", action: () => appItem.launch() })
            actions.push({ separator: true })
        } else if (appId === "home-shortcut" || appId === "special:home") {
            actions.push({ label: "Abrir", action: () => appItem.launch() })
            actions.push({ separator: true })
        } else if (appId === "trash" || appId === "special:trash") {
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
                            if (gAppInfo && gAppInfo.launch_action) gAppInfo.launch_action(actionName, null)
                        } catch (e) { console.error(e) }
                    }
                })
            })
            actions.push({ separator: true })
        }

        const isSpecialItem = appId.startsWith("special:") || appId === "launcher" || appId === "home-shortcut" || appId === "trash"
        if (!isSpecialItem) {
            actions.push({
                label: isPinned ? "Desanclar del dock" : "Mantener en el dock",
                action: () => {
                    const cid = cleanId || appId
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
                const b = new Gtk.Button({
                    css_classes: ["cd-menu-action"],
                    child: new Gtk.Label({ label: a.label, xalign: 0 })
                })
                if (a.isDestructive) b.add_css_class("destructive")
                b.connect("clicked", () => {
                    console.log(`[DockMenu] Action clicked, popping down: ${appId}`)
                    a.action();
                    p.popdown()
                })
                menu.append(b)
            }
        })

        p.set_child(menu)
    }

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => {
        console.error(`[DockMenu] Right-click released for: ${appId}`)
        rebuildMenu()
        // V320: Delay popup by 1 frame to ensure GTK has processed the new child/layout
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (popover) popover.popup()
            return GLib.SOURCE_REMOVE
        })
    })
    iconBox.add_controller(rightClick)

    // DRAG SOURCE
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE })
    source.connect("prepare", (s, x, y) => {
        s.set_icon(Gtk.WidgetPaintable.new(child), x, y)
        dragBus.setDragging(cleanId || appId)
        return (Gdk as any).ContentProvider.new_for_value(cleanId || rawId || appId)
    })
    source.connect("drag-end", () => {
        dragBus.setDragging("")
        dragBus.clearHover()
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
            if (target) {
                if (!target.startsWith("0x")) target = "0x" + target
                execAsync(`hyprctl dispatch focuswindow address:${target}`).catch(print)
            }
        } else {
            // Fallback or Launch
            try {
                if ((globalThis as any).triggerDockBounce) (globalThis as any).triggerDockBounce(appId)
                appItem.launch()
            } catch (e) {
                execAsync(`gtk-launch ${appId}`).catch(print)
            }
        }
    })
    iconBox.add_controller(leftClick)

    // V540: REDUNDANT DROP TARGET REMOVED. Consolidated in global handler.
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
        try { hypr.disconnect(c1) } catch (e) { }
        try { hypr.disconnect(c2) } catch (e) { }
        clientSignalIds.forEach(({ client, signalId }) => {
            try {
                if (GObject.signal_handler_is_connected(client, signalId)) {
                    client.disconnect(signalId)
                }
            } catch (e) { }
        })
        clientSignalIds.length = 0
    })
    sync()

        ; (itemBox as any).syncState = (newAddrs: string[], newTitle: string | undefined, newAppItem: any, newIsPinned: boolean) => {
            addresses = newAddrs
            clientTitle = newTitle
            appItem = newAppItem
            isPinned = newIsPinned

            state.addresses = newAddrs
            state.clientTitle = newTitle

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
