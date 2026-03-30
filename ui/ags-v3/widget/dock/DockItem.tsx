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

import { dragBus, mouseBus, dockSettings, changeMenuCount, menuState } from "./state"

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
export function Separator(id: string, updateDock: () => void, register: (id: string, s: any) => void,
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
        width_request: DOCK_CONSTANTS.SEPARATOR_LINE, height_request: DOCK_CONSTANTS.SEPARATOR_HEIGHT,
        hexpand: false,
    })

    box.set_center_widget(line)

    const state = {
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: baseWidth, currentWidth: baseWidth, velocityWidth: 0,
        targetMargin: 0, currentMargin: 0, velocityMargin: 0,
        targetHeight: DOCK_CONSTANTS.SEPARATOR_HEIGHT, currentHeight: DOCK_CONSTANTS.SEPARATOR_HEIGHT, velocityHeight: 0,
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
        margin_bottom: DOCK_CONSTANTS.PILL_PADDING,
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

        // V149.3: THEMED ICON RESOLUTION (GIO) 🛰️
        // If we have a raw Gio.AppInfo, we extract the GIcon and resolve its names.
        if (appItem.get_icon) {
            const gicon = appItem.get_icon()
            if (gicon instanceof Gio.ThemedIcon) {
                for (const n of gicon.get_names()) {
                    const res = appService.getIconName(n)
                    if (res) {
                        if (res.startsWith("/") || res.startsWith("file://")) return { path: res.replace("file://", "") }
                        return { name: res }
                    }
                }
            }
            return { gicon: gicon }
        }

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
    // V601: User requested removing all special handling for Antigravity or non-themed icons.
    // We treat everything as "themed" now so they all get the exact same background plate and scale.
    isThemed = true


    if (pixbuf) {
        // Custom Drawing
        child = new Gtk.DrawingArea()
        child.set_valign(Gtk.Align.CENTER)
        child.set_halign(Gtk.Align.CENTER)
            // Explicitly cast to any because TS definitions for Gtk4 DrawingArea might be incomplete in this environment
            ; (child as any).set_content_width(DOCK_CONSTANTS.ICON_SIZE)
            ; (child as any).set_content_height(DOCK_CONSTANTS.ICON_SIZE)

            ; (child as any).set_draw_func((area: any, cr: any, w: number, h: number) => {
                // macOS HIG: The actual icon shape only occupies ~82% of the total canvas.
                // V610: The global clipping and plate scale is locked at exactly 90%
                // V700: No artificial SAFE_RATIO. Use full canvas area.
                const cx = w / 2
                const cy = h / 2

                // Native aspect ratio
                const iconW = pixbuf.get_width()
                const iconH = pixbuf.get_height()

                // Scale to fit available area (in the 0.90 scaled context, space is w,h)
                const scaleX = w / iconW
                const scaleY = h / iconH
                // Contain strategy to guarantee it fits 
                // V610: Apply the user's extra scale only to the internal graphic itself,
                // so the fixed 90% clip mask will punch a perfect squircle.
                const scale = Math.min(scaleX, scaleY) * (1.0 + (dockSettings.iconThemeScale / 100))

                // Center in the widget area (w, h)
                const drawW = iconW * scale
                const drawH = iconH * scale
                const x = (w - drawW) / 2
                const y = (h - drawH) / 2

                cr.save()

                const isTrash = appId === "trash" || appId === "special:trash"

                cr.translate(x, y)
                cr.scale(scale, scale)

                Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
                cr.paint()
                cr.restore()

                // If animating, schedule next frame
                if (state.isBouncing) {
                    child.queue_draw()
                }
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
    child.set_has_tooltip(false)
    // Removed override: child.set_size_request(..., ...) - Size is handled by DrawingArea setup or Plate logic

    const state = {
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: DOCK_CONSTANTS.ICON_SIZE, currentWidth: DOCK_CONSTANTS.ICON_SIZE, velocityWidth: 0,
        targetMargin: DOCK_CONSTANTS.ICON_MARGIN, currentMargin: DOCK_CONSTANTS.ICON_MARGIN, velocityMargin: 0,
        targetHeight: DOCK_CONSTANTS.PILL_HEIGHT, currentHeight: DOCK_CONSTANTS.PILL_HEIGHT, velocityHeight: 0,
        targetTranslateY: 0, currentTranslateY: 0, velocityY: 0,
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: false,
        addresses: addresses as string[],
        clientTitle: clientTitle as string | undefined,
        widget: itemBox as Gtk.Widget,
        isBouncing: false,
        bounceOffsetY: 0
    }
    register(appId, state)
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return
            state.virtualCenter = v
            state.staticCenter = v
        }

    // V700: Reverted to vanilla icons. No background plate or squircle clipping.
    const iconToDisplay = child
    child.set_size_request(DOCK_CONSTANTS.ICON_SIZE, DOCK_CONSTANTS.ICON_SIZE)

    // (isAntigravity moved up)

    child.set_name("cd-icon-image-" + appId)
    iconBox.append(iconToDisplay)

    // macOS Tahoe: 4px perfect black circle — Cairo-drawn for pixel-perfect rendering
    const DOT_SIZE = 4
    const dot = new Gtk.DrawingArea({
        name: "cd-dot-" + appId,
        css_classes: ["cd-dot"],
        width_request: DOT_SIZE,
        height_request: DOT_SIZE,
        has_tooltip: false,
    })
        ; (dot as any).set_content_width(DOT_SIZE)
        ; (dot as any).set_content_height(DOT_SIZE)
        ; (dot as any).set_draw_func((_a: any, cr: any, w: number, h: number) => {
            // Best-quality anti-aliasing
            cr.setAntialias(3) // CAIRO_ANTIALIAS_BEST

            const cx = w / 2
            const cy = h / 2
            const r = DOT_SIZE / 2

            // 1. Subtle shadow halo (macOS depth effect)
            cr.arc(cx, cy + 0.5, r + 0.3, 0, Math.PI * 2)
            cr.setSourceRGBA(0, 0, 0, 0.25)
            cr.fill()

            // 2. Crisp main dot
            cr.arc(cx, cy, r, 0, Math.PI * 2)
            cr.setSourceRGBA(0, 0, 0, 0.9)
            cr.fill()
        })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: DOCK_CONSTANTS.INDICATOR_GAP,
        has_tooltip: false,
        width_request: DOT_SIZE, height_request: DOT_SIZE,
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
    // Re-implemented Popover for anchored positioning with GTK theme styling
    const tooltip = new Gtk.Popover({ position: Gtk.PositionType.TOP, autohide: false, has_arrow: true })
    const label = new Gtk.Label({ css_classes: ["label"] })
    const content = new Gtk.Box()
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
        if (popover && popover.visible) return // Don't show tooltip if menu is open

        if (!tooltip.visible && !tooltipTimeout) {
            tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                tooltip.popup(); tooltipTimeout = null; return GLib.SOURCE_REMOVE
            })
        }
    })
    motion.connect("leave", () => {
        if (tooltipTimeout) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        tooltip.popdown()
    })
    iconBox.add_controller(motion)

    // MENU
    // V700: Fully Native GTK4 PopoverMenu
    let popover: Gtk.Popover | null = null

    const toSentenceCase = (str: string) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : ""

    const rebuildMenu = () => {
        if (popover) {
            if (popover.visible) return
            popover.unparent()
            popover = null
        }

        console.error(`[DockMenu] Rebuilding native menu for: ${appId}`)

        const menuModel = new Gio.Menu()
        const actionGroup = new Gio.SimpleActionGroup()
        let actionIdx = 0

        const addAction = (callback: () => void) => {
            const actionName = `act_${actionIdx++}`
            const action = new Gio.SimpleAction({ name: actionName })
            action.connect("activate", callback)
            actionGroup.add_action(action)
            return `dock.${actionName}`
        }

        const addSection = (title: string | null) => {
            const section = new Gio.Menu()
            menuModel.append_section(title, section)
            return section
        }

        // Section 1: Main App (Standardize special names)
        let mainTitle = appItem.name || "App"
        if (appId === "launcher" || appId === "special:launcher") mainTitle = "Aplicaciones"
        if (appId === "home-shortcut" || appId === "special:home") mainTitle = "Archivos"
        if (appId === "trash" || appId === "special:trash") mainTitle = "Papelera"
        const mainSection = addSection(mainTitle)

        let desktopActions: string[] = []
        const gAppInfo = appService.getAppInfo(appId)
        if (gAppInfo && gAppInfo.list_actions) {
            desktopActions = gAppInfo.list_actions()
        }

        if (appId === "launcher" || appId === "special:launcher") {
            mainSection.append("Abrir", addAction(() => appItem.launch()))
        } else if (appId === "home-shortcut" || appId === "special:home") {
            // V149: UNIVERSAL HOME ISOLATION (Right Click) 🛰️
            mainSection.append("Abrir", addAction(() => {
                const command = appService.getDefaultFileManagerCommand()
                execAsync(["hyprctl", "dispatch", "exec", command]).catch(print)
            }))
        } else if (appId === "trash" || appId === "special:trash") {
            mainSection.append("Abrir", addAction(() => appItem.launch()))
            mainSection.append("Vaciar Papelera", addAction(() => execAsync("gio trash --empty").catch(print)))
        }

        if (desktopActions.length > 0) {
            const desktopSection = addSection(null)
            desktopActions.forEach((actionName: string) => {
                const rawLabel = actionName
                const label = gAppInfo ? gAppInfo.get_action_name(actionName) : toSentenceCase(rawLabel.replace(/[-_]/g, " "))
                desktopSection.append(label, addAction(() => {
                    try {
                        if (gAppInfo && gAppInfo.launch_action) gAppInfo.launch_action(actionName, null)
                    } catch (e) { console.error(e) }
                }))
            })
        }

        const isSpecialItem = appId.startsWith("special:") || appId === "launcher" || appId === "home-shortcut" || appId === "trash"
        if (!isSpecialItem) {
            const pinSection = addSection(null)
            pinSection.append(
                isPinned ? "Desanclar del dock" : "Mantener en el dock",
                addAction(() => {
                    const cid = cleanId || appId
                    if (isPinned) onUnpin(cid)
                    else onPin(cid)
                })
            )
        }

        if (state.addresses && state.addresses.length > 0) {
            const winCount = state.addresses.length

            // 1. List all open windows natively (Only if there's more than 1)
            if (winCount > 1) {
                const windowsSection = addSection(null)
                state.addresses.forEach((addr) => {
                    const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                    // Try to find the title from hypr.clients (Astal might omit the 0x in its internally mapped address)
                    const rawAddr = addr.replace(/^0x/, '')
                    const hyprClient = hypr.clients.find(c => c.address === cleanAddr || c.address === rawAddr)

                    // Use a substring to prevent gigantic unreadable menus
                    let winTitle = hyprClient?.title || `Ventana de ${appItem.name || "App"}`
                    if (winTitle.length > 35) winTitle = winTitle.substring(0, 32) + "..."

                    // Add the window to the menu. Clicking it focuses the window.
                    windowsSection.append(
                        winTitle,
                        addAction(() => {
                            execAsync(`hyprctl dispatch focuswindow address:${cleanAddr}`).catch(print)
                        })
                    )
                })
            }

            // 2. Add the destructive "Close All" action at the very bottom
            const closeSection = addSection(null)
            closeSection.append(
                winCount > 1 ? `Cerrar todas (${winCount})` : "Salir",
                addAction(() => {
                    state.addresses.forEach(addr => {
                        const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                        execAsync(`hyprctl dispatch closewindow address:${cleanAddr}`).catch(print)
                    })
                })
            )
        }

        iconBox.insert_action_group("dock", actionGroup)
        popover = Gtk.PopoverMenu.new_from_model(menuModel) as unknown as Gtk.Popover
        popover.set_has_tooltip(false)
        popover.set_parent(iconBox)

        popover.connect("notify::visible", () => {
            if (popover?.visible) {
                changeMenuCount(1)
            } else {
                // V700: Keep dock frozen for 250ms while the GTK menu plays its fade-out animation.
                // If we unfreeze instantly, the dock shrinks and visually clips the fading menu.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    changeMenuCount(-1)
                    return GLib.SOURCE_REMOVE
                })
            }
        })
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
                if (!state.isBouncing) {
                    state.isBouncing = true
                    const startTime = Date.now()
                    const duration = 1200
                    const amplitude = DOCK_CONSTANTS.ICON_SIZE * 0.35
                    const originalMargin = iconToDisplay.margin_bottom

                    sync() // Instantly turn on indicator when clicked

                    const animLoop = () => {
                        if (!state.isBouncing) return GLib.SOURCE_REMOVE

                        const elapsed = Date.now() - startTime
                        if (elapsed > duration) {
                            state.isBouncing = false
                            iconToDisplay.margin_bottom = originalMargin
                            child.queue_draw()
                            sync() // Re-evaluate indicator now that bounce is done
                            return GLib.SOURCE_REMOVE
                        }

                        // Calculate unified physics tick
                        const t = elapsed / duration
                        const decay = 4.0
                        const freq = Math.PI * 3.5
                        const offset = Math.abs(amplitude * Math.exp(-decay * t) * Math.sin(freq * t))

                        // V610: Apply offset physically to the layout margin instead of drawing matrix
                        iconToDisplay.margin_bottom = originalMargin + offset

                        // Force both layers to draw (although primarily to refresh shadow/bounds)
                        child.queue_draw()

                        return GLib.SOURCE_CONTINUE
                    }
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, animLoop)
                }

                // V149: UNIVERSAL HOME ISOLATION (Left Click) 🛰️
                if (appId === "special:home" || appId === "home-shortcut") {
                    const command = appService.getDefaultFileManagerCommand()
                    execAsync(["hyprctl", "dispatch", "exec", command]).catch(print)
                } else {
                    try {
                        appItem.launch()
                    } catch (e) {
                        execAsync(`gtk-launch ${appId}`).catch(print)
                    }
                }
            } catch (fallbackError) {
                // If the entire block fails, don't crash the dock
                console.error(fallbackError)
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

        // V610: Show indicator immediately if bouncing (launching) OR if explicitly open
        if ((isOpen || state.isBouncing) && dockSettings.showIndicators) {
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
        if (appId === "launcher" || appId === "special:launcher") targetTitle = "Aplicaciones"
        if (appId === "home-shortcut" || appId === "special:home") targetTitle = "Archivos"
        if (appId === "trash" || appId === "special:trash") targetTitle = "Papelera"
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

            sync()
        }

    return itemBox
}
