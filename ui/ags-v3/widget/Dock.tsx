import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
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

const savePinned = () => writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))

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

    // CLEAR BUFFER: Nukes any theme residue from the DrawingArea context
    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // SAFE MARGINS - Ensures rim and shadows are never clipped
    const marginY = 0 // FILL THE 92PX WIDGET
    const marginX = 12
    const drawH = height - (marginY * 2)
    const drawW = (targetW || width)
    const x = (width - drawW) / 2
    const y = marginY

    const r = drawH * 0.44
    const n = 3.2 // Apple's Golden Ratio for G2 Continuous Curve

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

    // 1. CLEAN OUTER SHADOW (Subtle grounding)
    cr.save()
    cr.rectangle(0, 0, width, height)
    path()
    cr.setFillRule(1)
    cr.clip()

    cr.save()
    cr.translate(0, 4)
    path(4)
    cr.setSourceRGBA(0, 0, 0, 0.10)
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

    // 3. MAIN BACKGROUND FILL (Stable Majestic Glass 12%)
    path()
    cr.setSourceRGBA(1, 1, 1, 0.12) // CATCH ALPHA - Translucent blur effect
    cr.fill()

    // 4. M3 RIM LIGHT
    path()
    cr.setSourceRGBA(1, 1, 1, 0.20)
    cr.setLineWidth(0.5)
    cr.stroke()
}

// --- DOCK ITEM COMPONENT ---

function DockItem(appItem: AstalApps.Application, updateDock: () => void, address?: string) {
    const appId = (appItem.get_id ? appItem.get_id() : (appItem.id || appItem.icon_name || appItem.name || "void")).replace(".desktop", "").toLowerCase()

    const itemBox = new Gtk.Box({
        name: "cd-item-" + appId,
        css_classes: ["cd-item"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        height_request: 92, // RESTORE 92px
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        margin_top: 0,
        margin_bottom: 0,
        margin_start: 0,
        margin_end: 0,
        can_focus: false, // DISABLE THEME INTERFERENCE
        focus_on_click: false, // HARDENING
        receives_default: false, // NUCLEAR: No default handling
        has_tooltip: false, // PREVENT NATIVE GHOST TOOLTIP
    })

    const iconBox = new Gtk.Box({
        name: "cd-icon-box-" + appId,
        css_classes: ["cd-icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END, // ANCHOR TO BOTTOM FOR GROWTH
        margin_bottom: 14,    // 14px from bottom of 92px widget
        margin_top: 0,
        margin_start: 0,
        margin_end: 0,
        has_tooltip: false, // PREVENT NATIVE GHOST TOOLTIP
    })

    const image = new Gtk.Image({
        name: "cd-icon-image-" + appId,
        icon_name: appItem.icon_name || "application-x-executable",
        pixel_size: 64,
        has_tooltip: false, // NUCLEAR
    })
    iconBox.append(image)

    const dot = new Gtk.Box({ name: "cd-dot-" + appId, css_classes: ["cd-dot"], has_tooltip: false })
    const indicator = new Gtk.Box({
        name: "cd-indicator-" + appId,
        css_classes: ["cd-indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 14, // 10 margin + 4 internal = INSIDE the crystal
        has_tooltip: false, // NUCLEAR
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        name: "cd-overlay-" + appId,
        css_classes: ["cd-overlay", "overlay"],
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.FILL,
        vexpand: true,
        has_tooltip: false, // NUCLEAR
    })
    overlay.set_child(iconBox)
    overlay.add_overlay(indicator)
    itemBox.append(overlay)

    // Tooltip
    const tooltip = new Gtk.Popover({
        name: "cd-tooltip-" + appId,
        css_classes: ["cd-tooltip"],
        position: Gtk.PositionType.TOP,
        autohide: false,
        has_arrow: false,
        has_tooltip: false, // NO NESTED TOOLTIPS
    })
    tooltip.set_name("cd-tooltip-" + appId) // EXPLICIT ID FORCE
    tooltip.set_offset(0, -12) // Ensure it floats clearly above magnified icons
    const label = new Gtk.Label({ name: "cd-tooltip-lbl-" + appId, label: appItem.name || "App", css_classes: ["cd-tooltip-label"], has_tooltip: false })
    const content = new Gtk.Box({ name: "cd-tooltip-box-" + appId, css_classes: ["cd-tooltip-content"], has_tooltip: false })
    content.append(label)
    tooltip.set_child(content)
    tooltip.set_parent(itemBox)

    let tooltipTimeout: number | null = null
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        if (tooltipTimeout) GLib.source_remove(tooltipTimeout)
        tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            tooltip.popup()
            tooltipTimeout = null
            return GLib.SOURCE_REMOVE
        })
    })
    motion.connect("leave", () => {
        if (tooltipTimeout) {
            GLib.source_remove(tooltipTimeout)
            tooltipTimeout = null
        }
        tooltip.popdown()
    })
    itemBox.add_controller(motion)

    // Interaction
    const isPinned = pinnedList.some(p => p.toLowerCase() === appId)
    const popover = new Gtk.Popover({ css_classes: ["cd-popover"], has_tooltip: false })
    popover.set_parent(itemBox)
    const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, has_tooltip: false })

    const actions = [
        { label: "Lanzar", action: () => appItem.launch() },
        {
            label: isPinned ? "Desanclar" : "Anclar", action: () => {
                if (isPinned) pinnedList = pinnedList.filter(p => p.toLowerCase() !== appId)
                else pinnedList.push(appId)
                savePinned(); updateDock()
            }
        }
    ]
    actions.forEach(a => {
        const b = new Gtk.Button({ label: a.label, css_classes: ["cd-menu-action"], has_tooltip: false })
        b.set_has_tooltip(false) // HARDENING
        b.set_has_frame(false) // HARDENING: No system frame drawing
        b.connect("clicked", () => { a.action(); popover.popdown() })
        menu.append(b)
    })
    popover.set_child(menu)

    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => popover.popup())
    itemBox.add_controller(rightClick)

    const leftClick = new Gtk.GestureClick({ button: 1 })
    leftClick.connect("released", () => {
        if (address) execAsync(`hyprctl dispatch focuswindow address:${address}`)
        else {
            const match = hypr.clients.find(c => (c.class || "").toLowerCase().includes(appId))
            if (match) execAsync(`hyprctl dispatch focuswindow address:${match.address}`)
            else appItem.launch()
        }
    })
    itemBox.add_controller(leftClick)

    // DND REORDERING
    if (isPinned) {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
        source.connect("prepare", (s, x, y) => {
            s.set_icon(Gtk.WidgetPaintable.new(image), x, y)
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
        const clients = hypr.clients
        const open = address ? clients.some(c => c.address === address) : clients.some(c => (c.class || "").toLowerCase().includes(appId))
        if (open) dot.add_css_class("open")
        else dot.remove_css_class("open")
    }
    const c1 = hypr.connect("notify::clients", sync)
    itemBox.connect("destroy", () => hypr.disconnect(c1))
    sync()

    return itemBox
}

// --- MAIN DOCK ---

export default function Dock(gdkmonitor: Gdk.Monitor) {
    const bar = new Gtk.Box({
        name: "the-dock-bar",
        css_classes: ["cd-dock-bar"], // Explicit class overrides defaults
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: 92, // PHYSICAL OBJECT HEIGHT
        spacing: 16,
        can_focus: false,
        has_tooltip: false, // NUCLEAR
    })
    const da = new Gtk.DrawingArea({
        name: "dock-drawing-area",
        css_classes: ["cd-drawing-area"],
        valign: Gtk.Align.FILL, // FILL WINDOW
        halign: Gtk.Align.CENTER,
        height_request: 160, // FULL CANVAS WIPE
        overflow: Gtk.Overflow.VISIBLE,
        margin_top: 0,
        margin_bottom: 0,
        can_focus: false,
        has_tooltip: false, // NUCLEAR
    })
    da.set_draw_func((_, cr, w, h) => {
        // === GPU BUFFER CLEAR ===
        // Ensures a clean surface before drawing
        cr.setOperator(0); // CAIRO_OPERATOR_CLEAR
        cr.paint();
        cr.setOperator(2); // CAIRO_OPERATOR_OVER

        // === GLASS DRAWING ===
        // Canvas is 160, Object is 92. Y = 160 - 92 = 68.
        const dockHeight = 92
        const yOffset = h - dockHeight

        cr.save()
        cr.translate(0, yOffset)
        drawSquircle(cr, w, dockHeight)
        cr.restore()
    })

    // 3. ID HIERARCHY: explicit names for every node
    const layout = new Gtk.Overlay({
        name: "dock-main-overlay", // ID: dock-main-overlay
        css_classes: ["cd-main-overlay"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        has_tooltip: false, // NUCLEAR
    })
    layout.set_child(da); layout.add_overlay(bar)
    layout.set_has_tooltip(false)

    // WRAPPER BOX matches Inspector's "dock-bar-container" but with strict ID
    const mainContainer = new Gtk.Box({
        name: "dock-main-container", // ID: dock-main-container
        css_classes: ["cd-dock-container"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.FILL,
        hexpand: true,
        vexpand: true,
        can_focus: false,
        has_tooltip: false, // NUCLEAR
    })
    mainContainer.append(layout)

    const update = () => {
        const items: Gtk.Widget[] = []

        pinnedList.filter(id => !!id).forEach(id => {
            const lid = id.toLowerCase()
            let appItem = appsService.list.find(a => {
                const aid = (a.get_id ? a.get_id() : a.id || "").toLowerCase()
                return aid.includes(lid)
            })
            if (!appItem) appItem = appsService.fuzzy_query(id)?.[0]
            if (appItem) items.push(DockItem(appItem, update))
        })

        const running = hypr.clients.filter(c => {
            const cls = (c.class || "").toLowerCase()
            if (cls.includes("ags")) return false
            return !pinnedList.some(p => cls.includes(p.toLowerCase()))
        })

        if (running.length > 0 && items.length > 0) items.push(Separator())

        running.forEach(c => {
            let appItem = appsService.fuzzy_query(c.class)?.[0]
            if (!appItem) {
                // @ts-ignore
                appItem = { name: c.title || c.class, icon_name: (c.class === "kitty" ? "terminal" : c.class), launch: () => execAsync(`hyprctl dispatch focuswindow address:${c.address}`) }
            }
            items.push(DockItem(appItem, update, c.address))
        })

        let child = bar.get_first_child()
        while (child) { const n = child.get_next_sibling(); bar.remove(child); child = n }
        items.forEach(i => bar.append(i))

        const [_, nat] = bar.get_preferred_size()
        if (nat) {
            const w = Math.ceil(nat.width) + 48 // 24px per side to accomodate 1.6x scale
            da.set_size_request(w, 160) // FULL CANVAS 160
            // CRITICAL: Window must be TALLER (160) to allow growth without clipping
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
    bar.connect("destroy", () => hypr.disconnect(cConn))
    update()
    return win
}
