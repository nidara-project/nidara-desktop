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
        css_classes: ["dock-separator"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
}

const drawSquircle = (cr: any, width: number, height: number, targetW?: number) => {
    if (width <= 0 || height <= 0) return
    const w = targetW || width
    const x = (width - w) / 2
    const r = height * 0.44 // Perfect balance for non-capsule appearance
    const n = 4.0 // High tension Lamé exponent

    cr.setAntialias(3)
    const getPoint = (t: number) => ({
        x: r * Math.pow(Math.abs(Math.cos(t)), 2 / n),
        y: r * Math.pow(Math.abs(Math.sin(t)), 2 / n)
    })

    const path = (d = 0) => {
        const rd = r + d
        cr.newPath()
        cr.moveTo(x + r, -d)
        cr.lineTo(x + w - r, -d)

        // Top-right
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + w - r + px, r - py)
        }
        // Bottom-right
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + w - r + px, height - r + py)
        }

        cr.lineTo(x + r, height + d)

        // Bottom-left
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, height - r + py)
        }
        // Top-left
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, r - py)
        }
        cr.closePath()
    }

    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // 1. CLEAN OUTER SHADOW (Dilation + Clip to avoid bleed-in)
    cr.save()
    cr.rectangle(0, 0, width, height)
    path()
    cr.setFillRule(1) // CAIRO_FILL_RULE_EVEN_ODD
    cr.clip()

    const shadowPasses = [
        { d: 8, o: 0.04, y: 6 }, // Far, soft lift
        { d: 4, o: 0.06, y: 3 }  // Near, grounding lift
    ]
    shadowPasses.forEach(pass => {
        cr.save()
        cr.translate(0, pass.y)
        path(pass.d)
        cr.setSourceRGBA(0, 0, 0, pass.o)
        cr.fill()
        cr.restore()
    })
    cr.restore()

    // 2. SPLIT DEFINITION BORDER (Sides & Bottom only)
    cr.newPath()
    cr.moveTo(x, height / 2)
    cr.lineTo(x, height - r)
    for (let i = 0; i <= 64; i++) {
        let t = (i / 64) * (Math.PI / 2)
        cr.lineTo(x + r - (r * Math.pow(Math.abs(Math.cos(t)), 2 / n)), height - r + (r * Math.pow(Math.abs(Math.sin(t)), 2 / n)))
    }
    cr.lineTo(x + w - r, height)
    for (let i = 64; i >= 0; i--) {
        let t = (i / 64) * (Math.PI / 2)
        cr.lineTo(x + w - r + (r * Math.pow(Math.abs(Math.cos(t)), 2 / n)), height - r + (r * Math.pow(Math.abs(Math.sin(t)), 2 / n)))
    }
    cr.lineTo(x + w, height / 2)
    cr.setSourceRGBA(0, 0, 0, 0.08) // Back to subtle
    cr.setLineWidth(1)
    cr.stroke()

    // 3. MAIN BACKGROUND FILL
    path()
    cr.setSourceRGBA(1, 1, 1, 0.12)
    cr.fill()

    // 4. M3 RIM LIGHT (Subtle Perimeter)
    path()
    cr.setSourceRGBA(1, 1, 1, 0.15) // Back to 15%
    cr.setLineWidth(0.5)           // Back to 0.5px
    cr.stroke()
}

// --- DOCK ITEM COMPONENT ---

function DockItem(appItem: AstalApps.Application, updateDock: () => void, address?: string) {
    const appId = (appItem.get_id ? appItem.get_id() : (appItem.id || appItem.icon_name || appItem.name || "void")).replace(".desktop", "").toLowerCase()

    const itemBox = new Gtk.Box({
        css_classes: ["dock-item"],
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.FILL,
        height_request: 92,
        overflow: Gtk.Overflow.VISIBLE,
        cursor: Gdk.Cursor.new_from_name("pointer", null),
    })

    const iconBox = new Gtk.Box({
        css_classes: ["icon-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        margin_bottom: 0,
    })

    const image = new Gtk.Image({
        icon_name: appItem.icon_name || "application-x-executable",
        pixel_size: 64,
    })
    iconBox.append(image)

    const dot = new Gtk.Box({ css_classes: ["indicator-dot"] })
    const indicator = new Gtk.Box({
        css_classes: ["indicator-container"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 6, // Lowered for better symmetry
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        overflow: Gtk.Overflow.VISIBLE,
        valign: Gtk.Align.FILL,
        vexpand: true,
    })
    overlay.set_child(iconBox)
    overlay.add_overlay(indicator)
    itemBox.append(overlay)

    // Tooltip
    const tooltip = new Gtk.Popover({
        css_classes: ["dock-tooltip"],
        position: Gtk.PositionType.TOP,
        autohide: false,
        has_arrow: false,
    })
    tooltip.set_offset(0, -12) // Ensure it floats clearly above magnified icons
    const label = new Gtk.Label({ label: appItem.name || "App", css_classes: ["tooltip-label"] })
    const content = new Gtk.Box({ css_classes: ["tooltip-content"] })
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
    const popover = new Gtk.Popover({ css_classes: ["dock-popover"] })
    popover.set_parent(itemBox)
    const menu = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })

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
        const b = new Gtk.Button({ label: a.label, css_classes: ["menu-action"] })
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
    const bar = new Gtk.Box({ name: "the-dock-bar", valign: Gtk.Align.END, halign: Gtk.Align.CENTER, overflow: Gtk.Overflow.VISIBLE, height_request: 92 })
    const da = new Gtk.DrawingArea({ valign: Gtk.Align.END, halign: Gtk.Align.CENTER, height_request: 92, overflow: Gtk.Overflow.VISIBLE })
    da.set_draw_func((_, cr, w, h) => { const [__, nat] = bar.get_preferred_size(); drawSquircle(cr, w, h, nat?.width) })

    const layout = new Gtk.Overlay({ name: "dock-overlay", valign: Gtk.Align.END, halign: Gtk.Align.CENTER, overflow: Gtk.Overflow.VISIBLE })
    layout.set_child(da); layout.add_overlay(bar)

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
            const w = Math.ceil(nat.width)
            da.set_size_request(w, 92)
            if (win) { win.set_default_size(w, 160); win.set_size_request(w, 160) }
        }
    }

    const win = (
        <window name="crystal-dock" namespace="crystal-dock" css_classes={["crystal-dock"]} gdkmonitor={gdkmonitor} anchor={Astal.WindowAnchor.BOTTOM} layer={Astal.Layer.TOP} application={app} visible heightRequest={160}>
            {layout}
        </window>
    ) as any as Gtk.Window
    win.set_decorated(false)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "crystal-dock");
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY); // Appear above EVERYTHING
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 10);
        Gtk4LayerShell.set_exclusive_zone(win, 102); // 10 margin + 92 bar = 102 (perfectly touches window with gaps_out:10)
    } catch (e) { console.error(e) }

    const cConn = hypr.connect("notify::clients", update)
    bar.connect("destroy", () => hypr.disconnect(cConn))
    update()
    return win
}
