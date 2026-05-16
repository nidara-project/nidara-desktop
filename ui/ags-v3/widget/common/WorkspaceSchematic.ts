import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import appService from "../../core/AppService"

// Shared physical-monitor dimension cache — populated on first sync per monitor name.
export const MonitorCache = new Map<string, { w: number, h: number }>()

export interface SchematicHandle {
    wrapper: Gtk.Box
    sync: (workspaces: any[], monitors: any[], clients: any[]) => void
}

/**
 * Creates a scaled schematic preview of a single workspace.
 *
 * @param wsId     - Hyprland workspace ID (1-based)
 * @param width    - Desired pixel width of the preview (height is computed from aspect ratio)
 * @param hyprland - AstalHyprland singleton; used for focused_workspace / focused_monitor fallbacks
 */
export function createSchematicMap(wsId: number, width: number, hyprland: any): SchematicHandle {
    const initialHeight = Math.round(width * (170 / 300))

    const wrapper = new Gtk.Box({
        css_classes: ["wo-schematic-preview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
    })

    const fixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-container"],
        hexpand: false,
        vexpand: false,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
    }) as any

    fixed.set_overflow(Gtk.Overflow.HIDDEN)
    wrapper.append(fixed)

    const barArea  = new Gtk.Box({ css_classes: ["wo-reserved-area", "bar"]  })
    const dockArea = new Gtk.Box({ css_classes: ["wo-reserved-area", "dock"] })
    fixed.put(barArea,  0, 0)
    fixed.put(dockArea, 0, 0)

    let cachedDrawHeight = initialHeight
    const winWidgets = new Map<string, { box: Gtk.Box, icon: Gtk.Image }>()

    wrapper.set_size_request(width, initialHeight)
    fixed.set_size_request(width, initialHeight)

    const sync = (workspaces: any[], monitors: any[], clients: any[]) => {
        const ws = workspaces.find((w: any) => w.id === wsId)
        const focusedWs = hyprland.focused_workspace

        let hMonitor = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === (ws?.monitor_id ?? -1))
        if (!hMonitor && wsId === focusedWs?.id) hMonitor = hyprland.focused_monitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === wsId) || monitors[0]
        if (!hMonitor || !hMonitor.width) return

        // Resolve physical dimensions (with GDK cross-check and snapping)
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
                    if (dist < minDist) { minDist = dist; bestMatch = geom }
                }
                if (bestMatch && minDist < 100) {
                    physW = bestMatch.width
                    physH = bestMatch.height
                    MonitorCache.set(hMonitor.name || "default", { w: physW, h: physH })
                }
            } catch (e) { }
        }

        // Snap to known resolutions to avoid fractional-scaling artifacts
        if (physH > 1000 && physH < 1500) physH = 1440
        if (physH > 800  && physH <= 1000) physH = 1080
        if (physW > 3000) physW = 3840
        else if (physW > 2000) physW = 2560
        else if (physW > 1800) physW = 1920

        const ratio = physW / physH
        if (ratio > 1.7 && ratio < 1.8) physH = (physW * 9)  / 16
        else if (ratio > 1.5 && ratio < 1.7) physH = (physW * 10) / 16

        const logicalW = Math.max(100, physW / (hMonitor.scale || 1))
        const logicalH = Math.max(100, physH / (hMonitor.scale || 1))
        const scale    = width / logicalW
        cachedDrawHeight = Math.round(logicalH * scale)

        wrapper.set_size_request(width, cachedDrawHeight)
        fixed.set_size_request(width, cachedDrawHeight)

        const bH = Math.round(44  * scale)
        const dH = Math.round(110 * scale)
        barArea.set_size_request(width, bH)
        dockArea.set_size_request(width, dH)
        fixed.move(dockArea, 0, cachedDrawHeight - dH)

        // Remove widgets for windows that are no longer on this workspace
        const wsClients = clients
            .filter((c: any) => c?.workspace?.id === wsId)
            .sort((a: any, b: any) => (b.focus_history_id || 0) - (a.focus_history_id || 0))

        const rTop    = (hMonitor as any).reserved_top    || 0
        const rBottom = (hMonitor as any).reserved_bottom || 0
        const rLeft   = (hMonitor as any).reserved_left   || 0
        const rRight  = (hMonitor as any).reserved_right  || 0

        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = winWidgets.get(addr)
                if (w) fixed.remove(w.box)
                winWidgets.delete(addr)
            }
        })

        const isPrimary = (hMonitor.x || 0) === 0 && (hMonitor.y || 0) === 0
        const barH = 44
        const dockH = 110

        wsClients.forEach((c: any) => {
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

            let widget = winWidgets.get(c.address)
            if (!widget) {
                const img = new Gtk.Image({
                    pixel_size: Math.min(w * 0.7, h * 0.7, 28),
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true,
                })
                const box = new Gtk.Box({
                    css_classes: ["wo-schematic-win"],
                    halign: Gtk.Align.FILL,
                    valign: Gtk.Align.FILL,
                    can_focus: false,
                    focusable: false,
                    hexpand: true,
                    vexpand: true,
                })
                box.append(img)
                fixed.put(box, x, y)
                widget = { box, icon: img }
                winWidgets.set(c.address, widget)
            } else {
                fixed.move(widget.box, x, y)
            }

            widget.box.set_size_request(Math.max(1, w), Math.max(1, h))
            widget.box.set_css_classes(["wo-schematic-win"])

            // Icon resolution — same logic as WO
            const iconId = c.class || "application-x-executable"
            const instance = (c as any).initialClass || (c as any).instance || ""
            let webAppIcon: string | null = null
            if (iconId.startsWith("chrome-") && iconId.endsWith("-default")) {
                const parts = iconId.split("-")
                if (parts.length >= 3) webAppIcon = parts[1]
            }
            const resolved =
                (webAppIcon ? appService.getIconName(webAppIcon) : null) ||
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

        // Keep chrome areas on top
        try {
            fixed.remove(barArea)
            fixed.put(barArea, 0, 0)
            fixed.remove(dockArea)
            fixed.put(dockArea, 0, cachedDrawHeight - dH)
        } catch (e) { }
    }

    return { wrapper, sync }
}
