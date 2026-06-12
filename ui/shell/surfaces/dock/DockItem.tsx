import { Astal, Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import Cairo from "gi://cairo"
import appService from "../../core/AppService"
import { DOCK_CONSTANTS } from "./DockPhysics"
import hs from "../../core/HyprlandState"

import { dragBus, mouseBus, pointerBus, dockSettings, changeMenuCount, menuState } from "./state"
import Theme from "../../core/ThemeManager"
import { t } from "../../core/i18n"
import shellActions from "../../core/ShellActions"

// hypr kept as alias for hs to minimise diff surface in this file
const hypr = hs

// Module-level tracker so Dock.tsx can dismiss the active popover when clicking dock background
let _activeDockMenu: Gtk.PopoverMenu | null = null
export function dismissActiveDockMenu() {
    if (_activeDockMenu?.visible) _activeDockMenu.popdown()
}

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
    const isSepVertical = dockSettings.position === 'left' || dockSettings.position === 'right'
    const baseWidth = DOCK_CONSTANTS.SEPARATOR_SLOT
    const box = new Gtk.CenterBox({
        css_classes: ["cd-separator-container"],
        valign: isSepVertical ? Gtk.Align.CENTER : Gtk.Align.END, halign: Gtk.Align.CENTER,
        width_request: isSepVertical ? DOCK_CONSTANTS.PILL_HEIGHT : baseWidth,
        height_request: isSepVertical ? baseWidth : DOCK_CONSTANTS.PILL_HEIGHT,
        hexpand: false,
        margin_bottom: 0,
    })

    // For vertical docks the separator is a horizontal hairline, not a vertical one.
    // Initialize dimensions to match what the tick would set so no layout jump occurs.
    const line = new Gtk.Box({
        name: "cd-separator", css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER,
        width_request: isSepVertical
            ? DOCK_CONSTANTS.SEPARATOR_HEIGHT
            : DOCK_CONSTANTS.SEPARATOR_LINE,
        height_request: isSepVertical
            ? DOCK_CONSTANTS.SEPARATOR_LINE
            : DOCK_CONSTANTS.SEPARATOR_HEIGHT,
        hexpand: false,
    })

    box.set_center_widget(line)

    const state = {
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: baseWidth, currentWidth: baseWidth, velocityWidth: 0,
        targetMargin: 0, currentMargin: 0, velocityMargin: 0,
        targetHeight: DOCK_CONSTANTS.SEPARATOR_HEIGHT, currentHeight: DOCK_CONSTANTS.SEPARATOR_HEIGHT, velocityHeight: 0,
        targetTranslateY: 0, currentTranslateY: 0, velocityY: 0,
        currentSlideX: 0, targetSlideX: 0, velocitySlideX: 0,
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
    const isVertical = dockSettings.position === 'left' || dockSettings.position === 'right'
    let rawId = "void"
    if (appItem.get_id) {
        rawId = appItem.get_id() || "void"
    } else {
        const key = (appItem as any).id || (appItem as any).icon_name || (appItem as any).name || "void"
        if (Array.isArray(key)) rawId = key[0]
        else if (typeof key === "string") rawId = key
    }
    rawId = rawId.replace(".desktop", "")

    const edgeAlign = isVertical
        ? (dockSettings.position === 'right' ? Gtk.Align.END : Gtk.Align.START)
        : Gtk.Align.START

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        // Horizontal: VERTICAL orientation stacks [icon zone, dot zone] top-to-bottom.
        // Vertical:   HORIZONTAL orientation keeps the side-indicator pattern.
        orientation: isVertical ? Gtk.Orientation.HORIZONTAL : Gtk.Orientation.VERTICAL,
        valign: isVertical ? Gtk.Align.START : Gtk.Align.END,
        // Vertical mirrors horizontal: anchored to the screen-edge side (edgeAlign,
        // not FILL) so the item grows toward screen center as the icon magnifies.
        halign: isVertical ? edgeAlign : Gtk.Align.START,
        hexpand: false,
        // Vertical shrink-wraps to [dotZone + iconBox] so its width is exactly
        // PILL_PADDING + current icon size; anchored to the edge it stays centered at
        // rest and grows toward center when magnified.
        width_request:  isVertical ? -1 : DOCK_CONSTANTS.ICON_SIZE,
        height_request: isVertical ? DOCK_CONSTANTS.ICON_SIZE   : DOCK_CONSTANTS.PILL_HEIGHT,
        margin_top:    isVertical ? DOCK_CONSTANTS.ICON_MARGIN : 0,
        margin_bottom: isVertical ? DOCK_CONSTANTS.ICON_MARGIN : 0,
        overflow: Gtk.Overflow.VISIBLE,
        can_focus: false,
        focusable: false,
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
        valign: isVertical ? Gtk.Align.CENTER : Gtk.Align.END,
        hexpand: false,
        // Horizontal: fills the icon zone (everything above the dot zone).
        vexpand: !isVertical,
        width_request:  isVertical ? DOCK_CONSTANTS.ICON_SIZE : -1,
        height_request: isVertical ? DOCK_CONSTANTS.ICON_SIZE : -1,
        margin_bottom: 0,
        has_tooltip: false,
        can_focus: false,
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

        return { name: "application-x-executable" }
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

        // If still no pixbuf, load the generic fallback icon so the DrawingArea path is always used
        if (!pixbuf) {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
            for (const fallbackName of ["application-x-executable", "image-missing"]) {
                if (!theme.has_icon(fallbackName)) continue
                const info = theme.lookup_icon(fallbackName, [], sourceSize, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_REGULAR)
                const file = info?.get_file()
                const path = file?.get_path()
                if (path) {
                    try { pixbuf = (GdkPixbuf as any).Pixbuf.new_from_file_at_scale(path, sourceSize, sourceSize, true) } catch (_) {}
                    if (pixbuf) break
                }
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
                if (w <= 0 || h <= 0) return
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
                const scale = Math.min(scaleX, scaleY)

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
            icon_name: res.name || "application-x-executable",
            pixel_size: DOCK_CONSTANTS.ICON_SIZE,
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
    child.set_size_request(DOCK_CONSTANTS.ICON_SIZE, DOCK_CONSTANTS.ICON_SIZE)

    const state = {
        targetScale: 1.0, currentScale: 1.0, velocityScale: 0,
        targetWidth: DOCK_CONSTANTS.ICON_SIZE, currentWidth: DOCK_CONSTANTS.ICON_SIZE, velocityWidth: 0,
        targetMargin: DOCK_CONSTANTS.ICON_MARGIN, currentMargin: DOCK_CONSTANTS.ICON_MARGIN, velocityMargin: 0,
        targetHeight: DOCK_CONSTANTS.PILL_HEIGHT, currentHeight: DOCK_CONSTANTS.PILL_HEIGHT, velocityHeight: 0,
        targetTranslateY: 0, currentTranslateY: 0, velocityY: 0,
        currentSlideX: 0, targetSlideX: 0, velocitySlideX: 0,
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

    const DOT_SIZE = 5
    const GAP = DOCK_CONSTANTS.INDICATOR_GAP

    // DrawingArea + Cairo: always a perfect circle regardless of GTK allocation.
    const dot = new Gtk.DrawingArea()
    dot.set_halign(Gtk.Align.CENTER)
    dot.set_valign(Gtk.Align.CENTER)
    ;(dot as any).set_content_width(DOT_SIZE)
    ;(dot as any).set_content_height(DOT_SIZE)
    dot.set_visible(false)
    ;(dot as any).set_draw_func((_area: any, cr: any, w: number, h: number) => {
        if (w <= 0 || h <= 0) return
        const r = Math.min(w, h) / 2
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI)
        const c = Theme.isDark ? 1 : 0
        cr.setSourceRGBA(c, c, c, 0.9)
        cr.fill()
    })

    if (isVertical) {
        // Mirror of the horizontal dotZone (which sits PILL_PADDING tall below the icon):
        // a PILL_PADDING-wide spacer on the screen-edge side that holds the indicator dot.
        // It both creates the rest gap to the pill wall AND lets the icon zone grow toward
        // center cleanly (pure Box layout — no Overlay main-child alignment quirks).
        dot.set_halign(Gtk.Align.CENTER)
        dot.set_valign(Gtk.Align.CENTER)
        const dotZone = new Gtk.CenterBox({
            orientation: Gtk.Orientation.VERTICAL,
            width_request: DOCK_CONSTANTS.PILL_PADDING,
            valign: Gtk.Align.FILL,
        })
        dotZone.set_center_widget(dot)
        if (dockSettings.position === 'right') {
            itemBox.append(iconBox)   // center side
            itemBox.append(dotZone)   // screen-edge side (right)
        } else {
            itemBox.append(dotZone)   // screen-edge side (left)
            itemBox.append(iconBox)   // center side
        }
        ;(itemBox as any)._cdIconBox = iconBox
        ;(itemBox as any)._cdDotZone = dotZone
    } else {
        // CenterBox guarantees its center_widget gets exactly its natural size (6×6),
        // rather than being stretched by a Gtk.Box parent layout pass.
        const dotZone = new Gtk.CenterBox({
            height_request: DOCK_CONSTANTS.PILL_PADDING,
            halign: Gtk.Align.FILL,
        })
        dotZone.set_center_widget(dot)
        itemBox.append(iconBox)
        itemBox.append(dotZone)
    }

    // TOOLTIP
    // Re-implemented Popover for anchored positioning with GTK theme styling
    const tooltipPosition = isVertical
        ? (dockSettings.position === 'right' ? Gtk.PositionType.LEFT : Gtk.PositionType.RIGHT)
        : Gtk.PositionType.TOP
    const tooltip = new Gtk.Popover({ position: tooltipPosition, autohide: false, has_arrow: true, css_classes: ["dock-tooltip"] })
    const label = new Gtk.Label({ css_classes: ["dock-tooltip-label"] })
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
    motion.connect("motion", (_controller, _x, _y) => {
        if (popover && popover.visible) return // Don't show tooltip if menu is open

        if (!tooltip.visible && !tooltipTimeout) {
            tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                // Refresh the title lazily, right before it becomes visible. Client.title
                // is live (AstalHyprland tracks windowtitle events) — what we avoid is
                // SUBSCRIBING to it (a dock redraw + blur pass per title tick); a one-shot
                // read at popup time is free and always fresh.
                updateLabel()
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
    // Dock context menu — created once, model updated before each show
    let popover: Gtk.PopoverMenu | null = null
    let popupIdleId: number | null = null

    const toSentenceCase = (str: string) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : ""

    const ensurePopover = () => {
        if (popover) return
        popover = Gtk.PopoverMenu.new_from_model(new Gio.Menu()) as unknown as Gtk.PopoverMenu
        popover.add_css_class("dock-menu")
        popover.set_has_tooltip(false)
        ;(popover as any).position = tooltipPosition
        popover.set_parent(iconBox)
        popover.connect("notify::visible", () => {
            if (popover?.visible) {
                _activeDockMenu = popover
                changeMenuCount(1)
            } else {
                _activeDockMenu = null
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    changeMenuCount(-1)
                    return GLib.SOURCE_REMOVE
                })
            }
        })
    }

    const updateMenuModel = () => {
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

        let mainTitle = appItem.name || "App"
        if (appId === "launcher" || appId === "special:launcher") mainTitle = t("settings.dock.dockitem.apps")
        if (appId === "home-shortcut" || appId === "special:home") mainTitle = t("dock.special.home.label")
        if (appId === "trash" || appId === "special:trash") mainTitle = t("dock.special.trash.name")
        const mainSection = addSection(mainTitle)

        let desktopActions: string[] = []
        const gAppInfo = appService.getAppInfo(appId)
        if (gAppInfo && gAppInfo.list_actions) desktopActions = gAppInfo.list_actions()

        if (appId === "launcher" || appId === "special:launcher") {
            mainSection.append(t("dock.menu.open"), addAction(() => appItem.launch()))
        } else if (appId === "home-shortcut" || appId === "special:home") {
            mainSection.append(t("dock.menu.open"), addAction(() => {
                execAsync(["uwsm", "app", "--", "xdg-open", GLib.get_home_dir()]).catch(print)
            }))
        } else if (appId === "trash" || appId === "special:trash") {
            mainSection.append(t("dock.menu.open"), addAction(() => appItem.launch()))
            mainSection.append(t("settings.dock.dockitem.empty-trash"), addAction(() => execAsync("gio trash --empty").catch(print)))
        }

        if (desktopActions.length > 0) {
            const desktopSection = addSection(null)
            desktopActions.forEach((actionName: string) => {
                const label = gAppInfo ? gAppInfo.get_action_name(actionName) : toSentenceCase(actionName.replace(/[-_]/g, " "))
                desktopSection.append(label, addAction(() => {
                    try { if (gAppInfo && gAppInfo.launch_action) gAppInfo.launch_action(actionName, null) }
                    catch (e) { console.error(e) }
                }))
            })
        }

        const isSpecialItem = appId.startsWith("special:") || appId === "launcher" || appId === "home-shortcut" || appId === "trash"
        if (!isSpecialItem) {
            const pinSection = addSection(null)
            pinSection.append(
                isPinned ? t("settings.dock.dockitem.unpin") : t("settings.dock.dockitem.keep"),
                addAction(() => { const cid = cleanId || appId; if (isPinned) onUnpin(cid); else onPin(cid) })
            )
        }

        if (state.addresses && state.addresses.length > 0) {
            const winCount = state.addresses.length
            if (winCount > 1) {
                const windowsSection = addSection(null)
                state.addresses.forEach((addr) => {
                    const cleanAddr = addr.startsWith("0x") ? addr : "0x" + addr
                    const rawAddr = addr.replace(/^0x/, '')
                    const hyprClient = hypr.clients.find(c => c.address === cleanAddr || c.address === rawAddr)
                    let winTitle = hyprClient?.title || `${t("dock.menu.window-of")} ${appItem.name || "App"}`
                    if (winTitle.length > 35) winTitle = winTitle.substring(0, 32) + "..."
                    windowsSection.append(winTitle, addAction(() => {
                        hs.focusWindow(cleanAddr)
                    }))
                })
            }
            const closeSection = addSection(null)
            closeSection.append(
                winCount > 1 ? `${t("settings.dock.dockitem.close-all")} (${winCount})` : t("settings.dock.dockitem.quit"),
                addAction(() => {
                    state.addresses.forEach(addr => {
                        hs.closeWindow(addr)
                    })
                })
            )
        }

        iconBox.insert_action_group("dock", actionGroup)
        ;(popover as any).set_menu_model(menuModel)
    }

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => {
        if (popupIdleId !== null) { GLib.source_remove(popupIdleId); popupIdleId = null }
        if (popover && popover.visible) { popover.popdown(); return }
        ensurePopover()
        updateMenuModel()
        popupIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            popupIdleId = null
            if (popover) popover.popup()
            return GLib.SOURCE_REMOVE
        })
    })
    iconBox.add_controller(rightClick)

    // DRAG — long-press to enter drag mode, then move to reorder.
    // Holding the icon for LONG_PRESS_MS ms makes it semi-transparent (drag ready);
    // releasing before then is treated as a click. Pointer tracking for reorder
    // preview is handled by Dock.tsx's window-level motion controller, not here.
    let gestureIsDragging = false
    let longPressTimer: number | null = null
    const LONG_PRESS_MS = 400

    const dragGesture = new Gtk.GestureDrag()
    dragGesture.connect("drag-begin", () => {
        if (longPressTimer !== null) { GLib.source_remove(longPressTimer); longPressTimer = null }
        longPressTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            longPressTimer = null
            if (dragBus.draggingId) return GLib.SOURCE_REMOVE  // another icon owns drag
            gestureIsDragging = true
            dragBus.setDragging(cleanId || appId)
            return GLib.SOURCE_REMOVE
        })
    })
    dragGesture.connect("drag-update", () => {
        // No-op: reorder preview is driven by Dock.tsx motion events.
    })
    dragGesture.connect("drag-end", () => {
        if (longPressTimer !== null) { GLib.source_remove(longPressTimer); longPressTimer = null }
        if (gestureIsDragging) {
            // Signal Dock.tsx to set isDndEnding and suppress the Hyprland-emitted
            // wl_pointer.leave that follows every drag-end. Regular clicks no longer
            // need this: the two-stage leave timer (50ms de-magnify, then hideDelay hide)
            // handles the leave→re-enter cycle correctly without blocking.
            pointerBus.emitButtonReleased()
            dragBus.setDragging("")
            dragBus.clearHover()
        }
        // Defer flag reset so leftClick.released (fires in the same event batch) still
        // sees gestureIsDragging = true and skips launching the app after a drag.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { gestureIsDragging = false; return GLib.SOURCE_REMOVE })
    })
    iconBox.add_controller(dragGesture)

    // CLICK (Focus/Launch)
    let bounceTimerId: number | null = null
    const leftClick = new Gtk.GestureClick({ button: 1 })
    leftClick.connect("released", () => {
        if (gestureIsDragging) return  // Button release after a drag — not a click
        if (addresses.length > 0) {
            const focusedAddr = hypr.focusedClient?.address
            const idx = addresses.indexOf(focusedAddr || "")
            const nextIdx = (idx + 1) % addresses.length
            const target = addresses[nextIdx]
            if (target) {
                hs.focusWindow(target)
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
                        if (!state.isBouncing) { bounceTimerId = null; return GLib.SOURCE_REMOVE }

                        const elapsed = Date.now() - startTime
                        if (elapsed > duration) {
                            state.isBouncing = false
                            iconToDisplay.margin_bottom = originalMargin
                            child.queue_draw()
                            sync() // Re-evaluate indicator now that bounce is done
                            bounceTimerId = null
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
                    if (bounceTimerId !== null) GLib.source_remove(bounceTimerId)
                    bounceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, animLoop)
                }

                // V149: UNIVERSAL HOME ISOLATION (Left Click) 🛰️
                if (appId === "special:home" || appId === "home-shortcut") {
                    execAsync(["uwsm", "app", "--", "xdg-open", GLib.get_home_dir()]).catch(print)
                } else if (appId === "crystal-shell-settings") {
                    shellActions.toggleSettings?.()
                } else {
                    // gtk-launch DOES inherit the launcher's CWD (verified) — without the
                    // cd, the app opens in the AGS process's dir (ui/shell) instead of
                    // $HOME. Reset it explicitly, mirroring DockCore.getLaunch. `exec` so
                    // gtk-launch replaces the shell (clean process tree under uwsm's scope).
                    execAsync(["uwsm", "app", "--", "sh", "-c",
                        `cd "$HOME" && exec gtk-launch ${GLib.shell_quote(appId)}`])
                        .catch(() => { try { appItem.launch() } catch (_) {} })
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
        if (appId === "launcher" || appId === "special:launcher") targetTitle = t("settings.dock.dockitem.apps")
        if (appId === "home-shortcut" || appId === "special:home") targetTitle = t("dock.special.home.label")
        if (appId === "trash" || appId === "special:trash") targetTitle = t("dock.special.trash.name")
        if (focused && addresses.includes(focused.address)) {
            targetTitle = focused.title
        } else if (addresses.length > 0) {
            const c = hypr.clients.find(c => c.address === addresses[0])
            if (c) targetTitle = c.title
        }
        // Guard: avoid surface commit when title hasn't changed
        const next = targetTitle || ""
        if (label.label !== next) label.set_label(next)
    }

    const hsChangedId = hs.connect("changed", sync)
    const themeChangedId = Theme.connect("changed", () => { if (dot.get_mapped()) dot.queue_draw() })

    // Note: notify::title per-client connections removed — they caused a dock surface
    // commit (and Hyprland blur pass) on every window title update from running apps
    // (e.g. YouTube tab progress, Discord unread count). hs.changed fires on actual
    // structural changes (focus, workspace, open/close) which is sufficient.

    itemBox.connect("destroy", () => {
        try { hs.disconnect(hsChangedId) } catch (e) { }
        try { Theme.disconnect(themeChangedId) } catch (e) { }
        // Pending timers would otherwise keep firing against destroyed widgets
        // (the dock is rebuilt in-process on position/autoHide/geometry changes).
        if (bounceTimerId !== null) { GLib.source_remove(bounceTimerId); bounceTimerId = null; state.isBouncing = false }
        if (tooltipTimeout !== null) { GLib.source_remove(tooltipTimeout); tooltipTimeout = null }
        if (longPressTimer !== null) { GLib.source_remove(longPressTimer); longPressTimer = null }
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
