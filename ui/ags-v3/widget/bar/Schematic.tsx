import { Gtk, Gdk } from "ags/gtk4"
import appService from "../../core/AppService"
import Icons from "../../core/Icons"

const BASE_WIDTH = 300
const BASE_HEIGHT = 170
const MonitorCache = new Map<string, { w: number, h: number }>()

/**
 * Schematic - A visual map of windows on a workspace 🛰️
 */
export function Schematic(wsId: number, hyprland: any, width = BASE_WIDTH) {
    const wrapper = new Gtk.Box({
        css_classes: ["wo-schematic-preview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
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

        // Rigid normalization
        if (physH > 1000 && physH < 1500) physH = 1440;
        if (physH > 800 && physH <= 1000) physH = 1080;
        if (physW > 3000) physW = 3840;
        else if (physW > 2000) physW = 2560;
        else if (physW > 1800) physW = 1920;

        const ratio = physW / physH
        if (ratio > 1.7 && ratio < 1.8) physH = (physW * 9) / 16;
        else if (ratio > 1.5 && ratio < 1.7) physH = (physW * 10) / 16;

        const logicalW = Math.max(100, physW / (hMonitor.scale || 1))
        const logicalH = Math.max(100, physH / (hMonitor.scale || 1))
        const scale = width / logicalW
        this.cachedDrawHeight = Math.round(logicalH * scale)

        wrapper.set_size_request(width, this.cachedDrawHeight)
        this.set_size_request(width, this.cachedDrawHeight)

        const bH = Math.round(44 * scale)
        const dH = Math.round(110 * scale)
        this.barArea.set_size_request(width, bH)
        this.dockArea.set_size_request(width, dH)
        this.move(this.dockArea, 0, this.cachedDrawHeight - dH)

        const wsClients = clients.filter((c: any) => c.workspace.id === this.wsId)
        const activeAddresses = new Set(wsClients.map((c: any) => c.address))

        this.winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = this.winWidgets.get(addr)
                if (w) this.remove(w.box)
                this.winWidgets.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            const isPrimary = (hMonitor.x || 0) === 0 && (hMonitor.y || 0) === 0
            const barH = 44
            const dockH = 110

            let rawX = c.x - (hMonitor.x || 0)
            let rawY = c.y - (hMonitor.y || 0)
            let rawW = c.width
            let rawH = c.height

            if (isPrimary && !c.floating) {
                if (rawY < barH) {
                    const diff = barH - rawY
                    rawY = barH
                    if (rawH > (logicalH - barH - dockH)) rawH -= (diff + 10)
                }
                if (rawY + rawH > (logicalH - dockH)) {
                    rawH = Math.max(10, (logicalH - dockH) - rawY - 4)
                }
            }

            const x = Math.round(rawX * scale)
            const y = Math.round(rawY * scale)
            const w = Math.round(rawW * scale)
            const h = Math.round(rawH * scale)

            const iconSize = Math.min(w * 0.7, h * 0.7, 32)

            let widget = this.winWidgets.get(c.address)
            if (!widget) {
                const img = new Gtk.Image({
                    icon_name: appService.getIconName(c.class) || "application-x-executable",
                    pixel_size: iconSize,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true
                , css_classes: ["cs-icon"] })
                const box = new Gtk.Box({
                    css_classes: ["wo-schematic-win"],
                    halign: Gtk.Align.FILL,
                    valign: Gtk.Align.FILL,
                })
                box.append(img)
                fixed.put(box, x, y)
                widget = { box, icon: img }
                this.winWidgets.set(c.address, widget)
            } else {
                widget.icon.pixel_size = iconSize
                fixed.move(widget.box, x, y)
            }

            widget.box.set_size_request(Math.max(1, w), Math.max(1, h))

            let iconId = c.class || "application-x-executable"
            const instance = (c as any).initialClass || (c as any).instance || ""
            const resolved = appService.getIconName(iconId) ||
                appService.getIconName(instance) ||
                "application-x-executable"
            widget.icon.set_from_icon_name(resolved)
            widget.icon.visible = w > 12 && h > 12
        })

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
