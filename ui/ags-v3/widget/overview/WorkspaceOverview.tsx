import GObject from "gi://GObject"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
// @ts-ignore
import Pango from "gi://Pango"
import app from "ags/gtk4/app"
import appService from "../../core/AppService"
import Gio from "gi://Gio"

const BASE_WIDTH = 300
const BASE_HEIGHT = 170

// V7.27: Constant Physical Architecture �️
const MonitorCache = new Map<string, { w: number, h: number }>()
const REFRESH_RATE = 500 // Generic heartbeat
function SchematicMap(wsId: number, hyprland: any) {
    const wrapper = new Gtk.Box({
        css_classes: ["wo-schematic-preview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        // No hardcoded size, let sync() handle it! 🛡️📐
    })

    const fixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-container"],
        hexpand: false,
        vexpand: false,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    }) as any

    fixed.set_overflow(Gtk.Overflow.HIDDEN)
    wrapper.append(fixed)

    fixed.wsId = wsId
    fixed.hyprland = hyprland
    fixed.winWidgets = new Map<string, { box: Gtk.Box, icon: Gtk.Image }>()
    fixed.cachedDrawHeight = BASE_HEIGHT

    const barArea = new Gtk.Box({ css_classes: ["wo-reserved-area", "bar"] })
    const dockArea = new Gtk.Box({ css_classes: ["wo-reserved-area", "dock"] })
    fixed.put(barArea, 0, 0)
    fixed.put(dockArea, 0, 0)
    fixed.barArea = barArea
    fixed.dockArea = dockArea

    fixed.sync = function (workspaces: any[], monitors: any[], clients: any[]) {
        const ws = workspaces.find((w: any) => w.id === this.wsId)
        const focusedWs = this.hyprland.focused_workspace

        let hMonitor = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === (ws?.monitor_id ?? -1))
        if (!hMonitor && this.wsId === focusedWs?.id) hMonitor = this.hyprland.focused_monitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === this.wsId) || monitors[0]

        if (!hMonitor || !hMonitor.width) return

        // V7.27: Geometric Unity 🛰️
        // We recover physical truth from Cache or GDK once.
        let physW = hMonitor.width
        let physH = hMonitor.height

        const cached = MonitorCache.get(hMonitor.name || "default")
        if (cached) {
            physW = cached.w
            physH = cached.h
        } else {
            try {
                const gdkMonitors = Gdk.Display.get_default()?.get_monitors()
                let bestMatch = null
                let minDist = Infinity

                for (let i = 0; i < (gdkMonitors?.get_n_items() || 0); i++) {
                    const gm = gdkMonitors?.get_item(i) as Gdk.Monitor
                    const geom = gm.get_geometry()
                    const dx = geom.x - (hMonitor.x || 0)
                    const dy = geom.y - (hMonitor.y || 0)
                    const dist = Math.sqrt(dx * dx + dy * dy)
                    if (dist < minDist) {
                        minDist = dist
                        bestMatch = geom
                    }
                }

                if (bestMatch && minDist < 100) {
                    physW = bestMatch.width
                    physH = bestMatch.height
                    MonitorCache.set(hMonitor.name || "default", { w: physW, h: physH })
                }
            } catch (e) { }
        }

        // Rigid normalization fallback (2K / 1080p standards)
        if (physH > 1000 && physH < 1500) physH = 1440;
        if (physH > 800 && physH <= 1000) physH = 1080;
        if (physW > 3000) physW = 3840;
        else if (physW > 2000) physW = 2560;
        else if (physW > 1800) physW = 1920;

        // V7.28: Immutable Aspect Ratio (Force 16:9 ground truth) 📐
        const ratio = physW / physH
        if (ratio > 1.7 && ratio < 1.8) physH = (physW * 9) / 16;
        else if (ratio > 1.5 && ratio < 1.7) physH = (physW * 10) / 16; // 16:10

        const logicalW = Math.max(100, physW / (hMonitor.scale || 1))
        const logicalH = Math.max(100, physH / (hMonitor.scale || 1))
        const scale = BASE_WIDTH / logicalW
        this.cachedDrawHeight = Math.round(logicalH * scale)

        if (this.wsId === focusedWs?.id) {
            // console.log(`[WO-Audit] WS:${this.wsId} Mon:${hMonitor.name} Phys:${physW}x${physH} Logic:${logicalW}x${logicalH} Scale:${scale}`)
        }

        wrapper.set_size_request(BASE_WIDTH, this.cachedDrawHeight)
        this.set_size_request(BASE_WIDTH, this.cachedDrawHeight)

        // Update Reserved Overlays 🛡️
        const bH = Math.round(44 * scale)
        const dH = Math.round(110 * scale)
        this.barArea.set_size_request(BASE_WIDTH, bH)
        this.dockArea.set_size_request(BASE_WIDTH, dH)
        this.move(this.dockArea, 0, this.cachedDrawHeight - dH)

        const wsClients = clients.filter((c: any) => c.workspace.id === this.wsId)
            .sort((a: any, b: any) => (b.focus_history_id || 0) - (a.focus_history_id || 0))

        // V7.13: Proper Reserved Indices and Geometry Compensation �️
        // V7.15: Proper Reserved Property Access 🛰️
        const rTop = (hMonitor as any).reserved_top || 0
        const rBottom = (hMonitor as any).reserved_bottom || 0
        const rLeft = (hMonitor as any).reserved_left || 0
        const rRight = (hMonitor as any).reserved_right || 0


        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        this.winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = this.winWidgets.get(addr)
                if (w) this.remove(w.box)
                this.winWidgets.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            // V7.28: Constant Physical Grounds 🛡️📐
            const isPrimary = (hMonitor.x || 0) === 0 && (hMonitor.y || 0) === 0
            const barH = 44
            const dockH = 110

            let rawX = c.x - (hMonitor.x || 0)
            let rawY = c.y - (hMonitor.y || 0)
            let rawW = c.width
            let rawH = c.height

            if (isPrimary && !c.floating) {
                // If windows are reported with full monitor height at cold-start
                // We force them down regardless of reported reserved areas
                if (rawY < barH) {
                    const diff = barH - rawY
                    rawY = barH
                    if (rawH > (logicalH - barH - dockH)) rawH -= (diff + 10) // +10 for gap
                }
                if (rawY + rawH > (logicalH - dockH)) {
                    rawH = Math.max(10, (logicalH - dockH) - rawY - 4)
                }
            }

            const x = Math.round(rawX * scale)
            const y = Math.round(rawY * scale)
            const w = Math.round(rawW * scale)
            const h = Math.round(rawH * scale)


            // V7.27: Simple & Centered Icon Architecture 🛡️✨
            const iconSize = Math.min(w * 0.7, h * 0.7, 28)

            let widget = this.winWidgets.get(c.address)
            if (!widget) {
                const img = new Gtk.Image({
                    icon_name: appService.getIconName(c.class) || "system-run-symbolic",
                    pixel_size: iconSize,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true
                })
                const box = new Gtk.Box({
                    css_classes: ["wo-schematic-win"],
                    halign: Gtk.Align.FILL,
                    valign: Gtk.Align.FILL,
                    can_focus: false,
                    focusable: false,
                    hexpand: true,
                    vexpand: true
                })
                box.append(img)
                fixed.put(box, x, y)
                widget = { box, icon: img }
                this.winWidgets.set(c.address, widget)
            } else {
                widget.icon.pixel_size = iconSize
                fixed.move(widget.box, x, y)
            }

            if (this.wsId === (this.hyprland as any).focused_workspace?.id && c.address === this.hyprland.focused_client?.address) {
                // console.log(`[WO-Debug] WS ${this.wsId} | Win: ${c.class} | RawY: ${c.y} | RawH: ${c.height} | ScaledY: ${y} | ScaledH: ${h}`)
            }

            widget.box.set_size_request(Math.max(1, w), Math.max(1, h))
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

            if (resolved.startsWith("/")) {
                widget.icon.set_from_gicon(Gio.FileIcon.new(Gio.File.new_for_path(resolved)))
            } else {
                widget.icon.set_from_icon_name(resolved)
            }

            widget.icon.pixel_size = Math.min(w * 0.7, h * 0.7, 32)
            widget.icon.visible = w > 12 && h > 12
        })

        // V7.15-V7.16: Bring Reserved Areas to FRONT 🛡️✨
        // Use remove and put for Gtk.Fixed reordering (Z-order)
        try {
            this.remove(this.barArea)
            this.put(this.barArea, 0, 0)
            this.remove(this.dockArea)
            this.put(this.dockArea, 0, this.cachedDrawHeight - dH)
        } catch (e) { }
    }

        ; (wrapper as any).schematic = fixed
    return wrapper as any
}

export default function WorkspaceOverview(monitor: any) {
    const hyprland = AstalHyprland.get_default()
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
        spacing: 32,
        css_classes: ["workspace-overview", "crystal-glass"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })

    const windowContent = new Gtk.Box({
        css_classes: ["cockpit-window-content"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true
    })
    windowContent.append(overview)

    const list = new Gtk.Grid({
        column_spacing: 16,
        row_spacing: 16,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { btn: Gtk.Button, schematic: any }>()

    for (let i = 1; i <= 5; i++) {
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
            height_request: 280, // V7.17: Increased for breathing room 🛡️
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
        const col = (i - 1) % 5
        const row = Math.floor((i - 1) / 5)
        list.attach(btn, col, row, 1, 1)
    }

    const syncAll = () => {
        try {
            if (!hyprland) return
            const monitors = hyprland.get_monitors() || []
            const workspaces = hyprland.get_workspaces() || []
            const clients = hyprland.get_clients() || []
            const focusedId = hyprland.focused_workspace?.id || 1
            const occupied = new Set(workspaces.map(ws => ws.id))

            slots.forEach((ctx, i) => {
                const isActive = focusedId === i
                const isOccupied = occupied.has(i)
                ctx.btn.visible = true // V7.10: Force all 10 to be visible 🎯

                const item = ctx.btn.child as Gtk.Box
                const header = item.get_first_child() as Gtk.Box
                const label = header.get_first_child() as Gtk.Label
                const count = header.get_last_child() as Gtk.Label

                item.set_css_classes(["wo-item", isActive ? "active" : ""])
                label.set_css_classes(["wo-label", isActive ? "active" : ""])

                const wsClients = clients.filter(c => c.workspace.id === i)
                count.label = wsClients.length > 0 ? wsClients.length.toString() : "󰝦"

                if (ctx.schematic && ctx.schematic.sync) {
                    ctx.schematic.sync(workspaces, monitors, clients)
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
        hyprland.connect("notify::focused-workspace", () => {
            console.log("[WO-Debug] Signal: focused-workspace")
            syncAll()
        }),
        hyprland.connect("notify::clients", () => {
            console.log("[WO-Debug] Signal: clients notify")
            syncAll()
        }),
        hyprland.connect("monitor-added", () => syncAll()),
        hyprland.connect("monitor-removed", () => syncAll()),
        hyprland.connect("event", (h, name, data) => {
            // Log ALL events for deep audit 🚀
            // console.log(`[WO-Debug] Raw Hypr Event: ${name}`)
            if (["workspace", "activewindow", "movewindow", "resizewindow", "openwindow", "closewindow", "fullscreen", "focusedmon"].includes(name)) {
                console.log(`[WO-Debug] REACTIVE Hypr Event: ${name}`)
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

    // V7.11: Faster Heart-beat sync (500ms) 💓
    const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        if (win.get_visible()) {
            syncAll()
        }
        return GLib.SOURCE_CONTINUE
    })

    win.connect("unrealize", () => {
        signals.forEach(id => hyprland.disconnect(id))
        GLib.source_remove(heartbeat)
    })

    overview.append(list)
    win.set_child(windowContent)

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncAll()
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { syncAll(); return GLib.SOURCE_REMOVE })
        return GLib.SOURCE_REMOVE
    })

    ;(win as any).toggle = () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const isVis = win.get_visible()
            win.set_visible(!isVis)
            if (!isVis) {
                win.present()
                syncAll()
            }
            return GLib.SOURCE_REMOVE
        })
    }

    return win
}
