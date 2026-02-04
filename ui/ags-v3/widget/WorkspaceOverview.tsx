import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import app from "ags/gtk4/app"
import { getWordmark } from "../utils"

/**
 * Schematic Map 🗺️
 * Flexible Expansion Engine: Adapts to the available slot size.
 */
function SchematicMap(wsId: number, hyprland: AstalHyprland.AstalHyprland, gdkMonitor: Gdk.Monitor) {
    const wrapper = new Gtk.Box({
        css_classes: ["wo-schematic-preview"],
        hexpand: true,
        vexpand: true,
        width_request: 120, // Min width
        height_request: 70  // Min height
    })

    const fixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-container"],
        hexpand: true,
        vexpand: true
    }) as Gtk.Fixed & { wsId: number, hyprland: AstalHyprland.AstalHyprland, winWidgets: Map<string, { box: Gtk.Box, label: Gtk.Label }>, sync: () => void }

    fixed.set_overflow(Gtk.Overflow.HIDDEN)
    wrapper.append(fixed)

    fixed.wsId = wsId
    fixed.hyprland = hyprland
    fixed.winWidgets = new Map<string, { box: Gtk.Box, label: Gtk.Label }>()

    fixed.sync = function () {
        const monitors = this.hyprland.get_monitors()
        const gGeo = gdkMonitor.get_geometry()
        const hMonitor = monitors.find(m => Math.abs(m.x - gGeo.x) < 100) || monitors[0]
        if (!hMonitor) return

        // --- REAL-TIME GEOMETRY ADAPTATION 🛡️⚖️ ---
        // We use the ACTUAL size of the widget as rendered by GTK.
        const drawWidth = this.get_width()
        const drawHeight = this.get_height()

        if (drawWidth < 10 || drawHeight < 10) return // Not yet realized

        const logicalW = hMonitor.width / (hMonitor.scale || 1)
        const logicalH = hMonitor.height / (hMonitor.scale || 1)

        const scaleX = drawWidth / logicalW
        const scaleY = drawHeight / logicalH

        // RESERVED AREAS (Fiducial Markers - Logical Units)
        const barH = Math.round((44 / (hMonitor.scale || 1)) * scaleY)
        const dockH = Math.round((104 / (hMonitor.scale || 1)) * scaleY)

        let bar = this.winWidgets.get("_bar")?.box
        if (!bar) {
            bar = new Gtk.Box({ css_classes: ["wo-schematic-reserved", "bar"] })
            this.put(bar, 0, 0)
            this.winWidgets.set("_bar", { box: bar, label: new Gtk.Label() })
        }
        bar.set_size_request(drawWidth, barH)

        let dock = this.winWidgets.get("_dock")?.box
        if (!dock) {
            dock = new Gtk.Box({ css_classes: ["wo-schematic-reserved", "dock"] })
            this.put(dock, 0, drawHeight - dockH)
            this.winWidgets.set("_dock", { box: dock, label: new Gtk.Label() })
        }
        dock.set_size_request(drawWidth, dockH)

        const clients = this.hyprland.get_clients() || []
        const wsClients = clients.filter(c => c.workspace.id === this.wsId && c.mapped)
            .sort((a, b) => b.focus_history_id - a.focus_history_id)

        // Clear extinct windows
        const activeAddresses = new Set(wsClients.map(c => c.address))
        activeAddresses.add("_bar")
        activeAddresses.add("_dock")
        this.winWidgets.forEach((_, addr) => {
            if (!activeAddresses.has(addr)) {
                this.remove(this.winWidgets.get(addr)!.box)
                this.winWidgets.delete(addr)
            }
        })

        wsClients.forEach(c => {
            const x1 = Math.round(c.x * scaleX)
            const y1 = Math.round(c.y * scaleY)
            const w = Math.round(c.width * scaleX)
            const h = Math.round(c.height * scaleY)

            let widget = this.winWidgets.get(c.address)
            if (!widget) {
                const box = new Gtk.Box({ css_classes: ["wo-schematic-win"], halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })
                const label = new Gtk.Label({
                    css_classes: ["wo-schematic-win-label"],
                    max_width_chars: 10,
                    ellipsize: Pango.EllipsizeMode.END,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true
                })
                box.append(label)
                this.put(box, x1, y1)
                widget = { box, label }
                this.winWidgets.set(c.address, widget)
            } else {
                this.move(widget.box, x1, y1)
            }

            widget.box.width_request = Math.max(1, w)
            widget.box.height_request = Math.max(1, h)
            widget.box.set_css_classes(["wo-schematic-win", c.focus_history_id === 0 ? "focused" : ""])
            widget.label.label = getWordmark(c, this.hyprland)
            widget.label.visible = w > 20 && h > 12
        })
    }

    return wrapper as any
}

export default function WorkspaceOverview(monitor: Gdk.Monitor, hyprland: AstalHyprland.AstalHyprland) {
    const win = new Gtk.Window({
        name: "workspace-cockpit",
        css_classes: ["workspace-cockpit"],
        application: app,
        visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "workspace-cockpit")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_exclusive_zone(win, 0)
        if (monitor) Gtk4LayerShell.set_monitor(win, monitor)
    } catch (e) { }

    const overview = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["workspace-overview"],
        width_request: 920,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START
    })

    const windowContent = new Gtk.Box({
        css_classes: ["cockpit-window-content"],
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.START
    })
    windowContent.append(overview)

    const list = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 14,
        halign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { btn: Gtk.Button, schematic: any }>()

    for (let i = 1; i <= 10; i++) {
        const schematic = SchematicMap(i, hyprland, monitor)
        const header = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
        const label = new Gtk.Label({ label: `WS ${i}`, css_classes: ["wo-label"] })
        const count = new Gtk.Label({ css_classes: ["wo-count"] })
        header.append(label)
        header.append(count)

        const item = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, css_classes: ["wo-item"], hexpand: true })
        item.append(header)
        item.append(schematic)

        const btn = new Gtk.Button({ child: item, css_classes: ["wo-btn"], hexpand: true })
        btn.connect("clicked", () => {
            hyprland.dispatch("workspace", i.toString())
            win.visible = false
        })

        const fixedWidget = (schematic as any).get_first_child()
        slots.set(i, { btn, schematic: fixedWidget })
        list.append(btn)
    }

    const syncAll = () => {
        const focusedId = hyprland.focused_workspace?.id || 1
        const workspaces = hyprland.get_workspaces() || []
        const occupied = new Set(workspaces.map(ws => ws.id))
        const clients = hyprland.get_clients() || []

        slots.forEach((ctx, i) => {
            const isActive = focusedId === i
            const isOccupied = occupied.has(i)
            ctx.btn.visible = i <= 5 || isOccupied || isActive

            const item = ctx.btn.child as Gtk.Box
            const header = item.get_first_child() as Gtk.Box
            const label = header.get_first_child() as Gtk.Label
            const count = header.get_last_child() as Gtk.Label

            item.set_css_classes(["wo-item", isActive ? "active" : ""])
            label.set_css_classes(["wo-label", isActive ? "active" : ""])
            label.opacity = isActive ? 1.0 : (isOccupied ? 0.7 : 0.3)

            const wsClients = clients.filter(c => c.workspace.id === i && c.mapped)
            count.label = wsClients.length > 0 ? wsClients.length.toString() : "󰝦"

            if (ctx.schematic.sync) ctx.schematic.sync()
        })
    }

    let warmupTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        warmupTimeout = 0
        syncAll()
        return GLib.SOURCE_REMOVE
    })

    const signals = [
        hyprland.connect("notify::clients", syncAll),
        hyprland.connect("notify::focused-workspace", syncAll),
        hyprland.connect("workspace-added", syncAll),
        hyprland.connect("workspace-removed", syncAll),
        win.connect("notify::visible", () => { if (win.get_visible()) syncAll() })
    ]

    win.connect("unrealize", () => {
        if (warmupTimeout) GLib.source_remove(warmupTimeout)
        signals.forEach(id => hyprland.disconnect(id))
    })

    overview.append(list)
    win.set_child(windowContent)
    return win
}
