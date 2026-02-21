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
import { dragBus, mouseBus, dockSettings } from "./state"

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
                const SAFE_RATIO = 0.90
                const cx = w / 2
                const cy = h / 2
                cr.translate(cx, cy)
                cr.scale(SAFE_RATIO, SAFE_RATIO)
                cr.translate(-cx, -cy)

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

                // V610: macOS Tahoe Launch Bounce Animation
                let bounceOffsetY = 0
                if (state.isBouncing) {
                    const elapsed = Date.now() - state.bounceStartTime
                    const duration = 1200 // 1.2 seconds total bounce animation
                    if (elapsed > duration) {
                        state.isBouncing = false
                    } else {
                        // Damped sine wave: y = A * e^(-decay * t) * sin(freq * t)
                        const t = elapsed / duration
                        const amplitude = w * 0.35 // Max bounce height is 35% of icon width
                        const decay = 4.0
                        const freq = Math.PI * 3.5 // roughly 1.75 full bounces
                        bounceOffsetY = amplitude * Math.exp(-decay * t) * Math.sin(freq * t)
                        // Absolute sine for continuous bouncing above ground, or regular sine for springy?
                        // macOS actually springs up, comes down flat, then springs up slightly less.
                        // Math.abs(sin) makes it bounce on a hard floor.
                        bounceOffsetY = Math.abs(bounceOffsetY)
                    }
                }

                const isTrash = appId === "trash" || appId === "special:trash"

                // V135: The clip mask is mathematically pure at the FULL 100% boundary limit!
                // Any native icons that DO bleed (or Antigravity) will instantly be clipped perfectly.
                // We use Apple's continuous formula. Testing n=4.0 for a rounder, less inflated shape.
                // V610: Do not clip the Trash icon, it should be free-floating
                if (!isTrash) {
                    // Offset the clip mask itself so the icon moves physically
                    createSquirclePath(cr, 0, -bounceOffsetY, w, h, w * 0.5, 4.0, false, 0)
                    cr.clip()
                }

                cr.translate(x, y - bounceOffsetY)
                cr.scale(scale, scale)

                Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
                cr.paint()
                cr.restore()

                // V136: Universal Apple-Style Glassy Highlight (Refined: Inset 1px)
                // V610: Trash icon does not get a glass highlight
                if (!isTrash) {
                    cr.save()
                    // Inset by 0.5px so 1.0px stroke stays perfectly within bounds
                    // V144: Sync radius with 0.5 and n=4.0 to perfectly match the clip mask and plate
                    createSquirclePath(cr, 0.5, 0.5, w - 1, h - 1, (w * 0.5) - 0.5, 4.0, false, 0)

                    // V610: Diagonal lighting (Top-Left to Bottom-Right) matching macOS HIG
                    // The gradient vector is slightly compressed inward to stretch the light
                    // iso-bands across a wider crescent of the top and left edges.
                    const highlightPat = new Cairo.LinearGradient(w * 0.1, (h * 0.1) - bounceOffsetY, w * 0.9, (h * 0.9) - bounceOffsetY)

                    // TOP-LEFT: Strong bright sweep that extends further along the edges
                    highlightPat.addColorStopRGBA(0.0, 1, 1, 1, 0.65)
                    highlightPat.addColorStopRGBA(0.40, 1, 1, 1, 0.0)

                    // MID: Completely transparent so sides aren't illuminated
                    highlightPat.addColorStopRGBA(0.5, 1, 1, 1, 0.0)

                    // BOTTOM-RIGHT: Subtle rim light reflection
                    highlightPat.addColorStopRGBA(0.65, 1, 1, 1, 0.0)
                    highlightPat.addColorStopRGBA(1.0, 1, 1, 1, 0.35)

                    cr.setLineWidth(1.0)
                    cr.setSource(highlightPat)
                    cr.stroke()
                    cr.restore()
                }

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
        widget: itemBox as Gtk.Widget,
        isBouncing: false,
        bounceStartTime: 0
    }
    register(appId, state)
        ; (itemBox as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return
            state.virtualCenter = v
            state.staticCenter = v
        }

    const isApp = (!!res.name || !!res.path || !!res.gicon)
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
            const isTrash = appId === "trash" || appId === "special:trash"
            if (isTrash) return

            // We draw the glassy plate for all icons now to ensure uniformity

            // macOS HIG: Matched scaling for the Plate to follow the 90% icon rule
            // The plate represents the physical bounds, keeping it completely static.
            const SAFE_RATIO = 0.90
            const cx = w / 2
            const cy = h / 2

            // V610: macOS Tahoe Launch Bounce Animation (Plate Sync)
            let bounceOffsetY = 0
            if (state.isBouncing) {
                const elapsed = Date.now() - state.bounceStartTime
                const duration = 1200
                if (elapsed > duration) {
                    state.isBouncing = false // normally controlled by child, but safe to set here too
                } else {
                    const t = elapsed / duration
                    const amplitude = w * 0.35
                    const decay = 4.0
                    const freq = Math.PI * 3.5
                    bounceOffsetY = Math.abs(amplitude * Math.exp(-decay * t) * Math.sin(freq * t))
                }
            }

            // Apply bounce offset to the entire plate assembly
            cr.translate(0, -bounceOffsetY)

            // V610: Individual Icon Drop Shadow (macOS Tahoe)
            // Simulating a blurred drop shadow using stacked low-opacity passes
            // drawn into the 5% margin outside the 90% scaled icon.
            cr.save()
            cr.translate(cx, cy)
            for (let i = 1; i <= 4; i++) {
                cr.save()
                // Shift down slightly and expand outward
                cr.translate(0, i * 1.0)
                const shadowScale = SAFE_RATIO + (i * 0.015)
                cr.scale(shadowScale, shadowScale)
                cr.translate(-cx, -cy)
                createSquirclePath(cr, 0, 0, w, h, w * 0.5, 4.0, false, 0)
                cr.setSourceRGBA(0, 0, 0, 0.04) // exceptionally soft black
                cr.fill()
                cr.restore()
            }
            cr.restore()

            cr.translate(cx, cy)
            cr.scale(SAFE_RATIO, SAFE_RATIO)

            // V610: Anti-aliasing bleed fix! 
            // Shrink the white background plate by 1% so it perfectly hides BEHIND 
            // the clipped icon, preventing its white antialiased edges from causing a halo.
            cr.scale(0.99, 0.99)

            cr.translate(-cx, -cy)

            // V413: Use shared drawSquircle for consistent geometry
            // V610: Disable enableGloss (false) here so the plate doesn't draw its own generic border, 
            // since we now draw our own pixel-perfect custom diagonal highlight over the icon!
            drawSquircle(cr, w, h, undefined, PLATE_OPACITY, false, undefined, Math.min(w, h) * 0.5, false, undefined, 4.0)

            // If animating, schedule next frame for the plate too
            if (state.isBouncing) {
                da.queue_draw()
            }
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
                if (!state.isBouncing) {
                    state.isBouncing = true
                    state.bounceStartTime = Date.now()
                    child.queue_draw() // Kick off the animation loop
                }
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

        if (isOpen && dockSettings.showIndicators) {
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
