import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
// @ts-ignore
import Pango from "gi://Pango"
import app from "ags/gtk4/app"
import appService from "../core/AppService"

const BASE_WIDTH = 300
const BASE_HEIGHT = 170

/**
 * Schematic Map V5 🗺️
 * Simplified Edition - Focusing on Layout & Icons.
 */
function SchematicMap(wsId: number, hyprland: any) {
    const wrapper = new Gtk.Box({
        css_classes: ["wo-schematic-preview"],
        width_request: BASE_WIDTH,
        height_request: BASE_HEIGHT
    })

    const fixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-container"],
        hexpand: true,
        vexpand: true,
    }) as any

    fixed.set_overflow(Gtk.Overflow.HIDDEN)
    wrapper.append(fixed)

    fixed.wsId = wsId
    fixed.hyprland = hyprland
    fixed.winWidgets = new Map<string, { box: Gtk.Box, icon: Gtk.Image }>()
    fixed.cachedDrawHeight = BASE_HEIGHT

    fixed.sync = function () {
        const monitors = this.hyprland.get_monitors() || []
        const workspaces = this.hyprland.get_workspaces() || []
        const ws = workspaces.find((w: any) => w.id === this.wsId)
        const focusedWs = this.hyprland.focused_workspace

        let hMonitor = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === (ws?.monitor_id ?? -1))
        if (!hMonitor && this.wsId === focusedWs?.id) hMonitor = this.hyprland.focused_monitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === this.wsId) || monitors[0]

        if (!hMonitor || !hMonitor.width) return

        // V7.8: Absolute Ground Truth via GDK Coordinates 🛰️
        let physW = hMonitor.width
        let physH = hMonitor.height

        try {
            const gdkMonitors = Gdk.Display.get_default()?.get_monitors()
            for (let i = 0; i < (gdkMonitors?.get_n_items() || 0); i++) {
                const gm = gdkMonitors?.get_item(i) as Gdk.Monitor
                const geom = gm.get_geometry()
                // Match by absolute coordinates (x, y) - This is the most robust way 🛡️
                if (geom.x === (hMonitor.x || 0) && geom.y === (hMonitor.y || 0)) {
                    physW = geom.width
                    physH = geom.height
                    break
                }
            }
        } catch (e) { }

        // Secondary fallback: Add back reserved margins if GDK fails
        if (physH === hMonitor.height && (hMonitor as any).reserved) {
            const res = (hMonitor as any).reserved
            physH += (res[0] || 0) + (res[1] || 0) // top + bottom
            physW += (res[2] || 0) + (res[3] || 0) // left + right
        }

        let logicalW = Math.max(100, physW / (hMonitor.scale || 1))
        let logicalH = Math.max(100, physH / (hMonitor.scale || 1))

        // V7.3: Absolute Scaling Reference 🎯
        const scale = BASE_WIDTH / logicalW
        this.cachedDrawHeight = Math.round(logicalH * scale)

        if (this.wsId === focusedWs?.id) {
            // console.log(`[WO-Debug] ACTIVE WS Sync | Res: ${logicalW}x${logicalH} | DrawH: ${this.cachedDrawHeight}`)
        }

        wrapper.set_size_request(BASE_WIDTH, this.cachedDrawHeight)
        this.set_size_request(BASE_WIDTH, this.cachedDrawHeight)

        const clients = this.hyprland.get_clients() || []
        const wsClients = clients.filter((c: any) => c.workspace.id === this.wsId)
            .sort((a: any, b: any) => b.focus_history_id - a.focus_history_id)

        // V7.4: Geometry Refinement for Bar/Dock 🛡️
        // Ensure x,y are strictly relative to physical monitor
        const hTop = hMonitor.reserved?.[0] || 0
        const hBottom = hMonitor.reserved?.[1] || 0

        if (this.wsId === focusedWs?.id) {
            // Log if we are hitting high-occupancy 🛡️
            // console.log(`[WO-Debug] Active WS ${this.wsId} rendering ${wsClients.length} clients`)
        }

        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        this.winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = this.winWidgets.get(addr)
                if (w) this.remove(w.box)
                this.winWidgets.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            // V7: Robust Relative Coordinates 🛰️
            const x = Math.round((c.x - (hMonitor.x || 0)) * scale)
            const y = Math.round((c.y - (hMonitor.y || 0)) * scale)
            const w = Math.round(c.width * scale)
            const h = Math.round(c.height * scale)

            // Log raw coordinates for inspection 🛡️
            if (this.wsId === focusedWs?.id && c.address === this.hyprland.focused_client?.address) {
                // console.log(`[WO-Debug] Focused Win Relative: ${x},${y} (Raw: ${c.x},${c.y} - Mon: ${hMonitor.x},${hMonitor.y})`)
            }

            let widget = this.winWidgets.get(c.address)
            if (!widget) {
                const box = new Gtk.Box({
                    css_classes: ["wo-schematic-win"],
                    halign: Gtk.Align.FILL,
                    valign: Gtk.Align.FILL,
                    can_focus: false,
                    focusable: false
                })
                const icon = new Gtk.Image({
                    css_classes: ["wo-schematic-win-icon"],
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true,
                    can_focus: false,
                    focusable: false
                })
                box.append(icon)
                this.put(box, x, y)
                widget = { box, icon }
                this.winWidgets.set(c.address, widget)
            } else {
                this.move(widget.box, x, y)
            }

            if (this.wsId === (this.hyprland as any).focused_workspace?.id && c.address === this.hyprland.focused_client?.address) {
                // console.log(`[WO-Debug]   TopWin: ${c.class} | Raw: ${c.x},${c.y} ${c.width}x${c.height} | Scaled: ${x},${y} ${w}x${h}`)
            }

            widget.box.width_request = Math.max(1, w)
            widget.box.height_request = Math.max(1, h)
            widget.box.set_css_classes(["wo-schematic-win"])

            // Icon Logic 🖼️ (Robust lookup for Webapps)
            let iconId = c.class || "application-x-executable"
            const instance = (c as any).initialClass || (c as any).instance || ""

            // Webapp heuristic: chrome-google.com-default -> google.com
            let webAppIcon = null
            if (iconId.startsWith("chrome-") && iconId.endsWith("-default")) {
                const parts = iconId.split("-")
                if (parts.length >= 3) webAppIcon = parts[1]
            }

            const resolved = (webAppIcon ? appService.getIconName(webAppIcon) : null) ||
                appService.getIconName(iconId) ||
                appService.getIconName(instance) ||
                appService.getIconName(c.initialTitle || "") ||
                "application-x-executable"

            widget.icon.set_from_icon_name(resolved)

            // Centering & Scaling 🎯
            widget.icon.pixel_size = Math.min(w * 0.7, h * 0.7, 48)
            widget.icon.visible = w > 16 && h > 16
        })
    }

        ; (wrapper as any).schematic = fixed
    return wrapper as any
}

export default function WorkspaceOverview(monitor: any, hyprland: any) {
    const win = new Gtk.Window({
        name: "workspace-cockpit",
        css_classes: ["workspace-cockpit"],
        visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "workspace-cockpit")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true) // Full center! 🎯
        Gtk4LayerShell.set_exclusive_zone(win, 0)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
        if (monitor) Gtk4LayerShell.set_monitor(win, monitor)
    } catch (e) { }

    const overview = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["workspace-overview", "crystal-glass"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false,
        vexpand: false
    })

    const windowContent = new Gtk.Box({
        css_classes: ["cockpit-window-content"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true
    })
    windowContent.append(overview)

    const list = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 16,
        halign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { btn: Gtk.Button, schematic: any }>()

    for (let i = 1; i <= 10; i++) {
        const schematic = SchematicMap(i, hyprland)
        const label = new Gtk.Label({ label: `WS ${i}`, css_classes: ["wo-label"] })
        const count = new Gtk.Label({ css_classes: ["wo-count"] })
        const header = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER })
        header.append(label); header.append(count)

        const item = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ["wo-item"],
            width_request: BASE_WIDTH + 24,
            height_request: 220,
            hexpand: false
        })
        item.append(header); item.append(schematic)

        const btn = new Gtk.Button({ child: item, css_classes: ["wo-btn"] })
        btn.set_focus_on_click(false) // Disable GTK focus 🛡️
        btn.connect("clicked", () => {
            hyprland.dispatch("workspace", i.toString())
            win.visible = false
        })

        slots.set(i, { btn, schematic: (schematic as any).schematic })
        list.append(btn)
    }

    const syncAll = () => {
        try {
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

                const wsClients = clients.filter(c => c.workspace.id === i)
                count.label = wsClients.length > 0 ? wsClients.length.toString() : "󰝦"

                if (ctx.schematic && ctx.schematic.sync) {
                    ctx.schematic.sync()
                }
            })
        } catch (e) {
            console.error(`[WO-Error] syncAll failed: ${e}`)
        }
    }

    const runPulse = (times = 20) => {
        syncAll()
        if (times > 0) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { runPulse(times - 1); return GLib.SOURCE_REMOVE })
    }

    const signals = [
        hyprland.connect("notify::focused-workspace", syncAll),
        hyprland.connect("notify::clients", syncAll),
        hyprland.connect("event", (h, name, data) => {
            // Expanded reactive triggers 🚀
            if (["workspace", "activewindow", "movewindow", "resizewindow", "openwindow", "closewindow", "fullscreen"].includes(name)) {
                syncAll()
            }
        }),
        win.connect("map", () => runPulse(10)),
        win.connect("notify::visible", () => {
            if (win.visible) {
                syncAll()
                runPulse(15) // Progressive sync for 15 seconds to catch layout stability 🛡️
            }
        })
    ]

    win.connect("unrealize", () => signals.forEach(id => hyprland.disconnect(id)))

    overview.append(list)
    win.set_child(windowContent)

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { syncAll(); return GLib.SOURCE_REMOVE })

    return win
}
