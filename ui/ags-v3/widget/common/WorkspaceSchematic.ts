import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import appService from "../../core/AppService"
import hs from "../../core/HyprlandState"

export interface SchematicHandle {
    wrapper: Gtk.Box
    sync: () => void
}

export function createSchematicMap(wsId: number, width: number): SchematicHandle {
    const initialHeight = Math.round(width * (9 / 16))

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

    const winWidgets = new Map<string, { box: Gtk.Box, icon: Gtk.Image }>()

    wrapper.set_size_request(width, initialHeight)
    fixed.set_size_request(width, initialHeight)

    const sync = () => {
        const workspaces = hs.workspaces
        const monitors   = hs.monitors
        const clients    = hs.clients

        const ws = workspaces.find((w: any) => w.id === wsId)

        let hMonitor: any = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === (ws?.monitor_id ?? -1))
        if (!hMonitor && wsId === hs.focusedWorkspaceId) hMonitor = hs.focusedMonitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === wsId) ?? monitors[0]
        if (!hMonitor?.width) return

        // hMonitor.width/height are physical pixels; divide by scale for logical coords.
        // Window positions (c.x/y) already encode bar+dock+gaps — just scale directly.
        const scaleFactor = hMonitor.scale || 1
        const logicalW    = hMonitor.width  / scaleFactor
        const logicalH    = hMonitor.height / scaleFactor
        const scale       = width / logicalW
        const drawH       = Math.round(logicalH * scale)

        wrapper.set_size_request(width, drawH)
        fixed.set_size_request(width, drawH)

        const monX = hMonitor.x || 0
        const monY = hMonitor.y || 0

        const wsClients = clients
            .filter((c: any) => c?.workspace?.id === wsId)
            .sort((a: any, b: any) => (b.focus_history_id || 0) - (a.focus_history_id || 0))

        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = winWidgets.get(addr)
                if (w) fixed.remove(w.box)
                winWidgets.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            // Compute left and right edges independently so rounding errors don't
            // accumulate — otherwise x+w != round(right_edge) and the outer gaps
            // become asymmetric (1px left, 0px right).
            const x    = Math.round((c.x - monX) * scale)
            const xEnd = Math.round((c.x - monX + c.width)  * scale)
            const y    = Math.round((c.y - monY) * scale)
            const yEnd = Math.round((c.y - monY + c.height) * scale)
            const w    = Math.max(4, xEnd - x)
            const h    = Math.max(4, yEnd - y)

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

            widget.box.set_size_request(w, h)
            widget.box.set_css_classes(["wo-schematic-win"])

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
    }

    return { wrapper, sync }
}
