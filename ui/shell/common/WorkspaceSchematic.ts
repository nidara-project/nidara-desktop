import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import appService from "../core/AppService"
import hs from "../core/HyprlandState"

export interface SchematicHandle {
    wrapper: Gtk.Widget
    sync: () => void
}

interface Tile { x: number; y: number; w: number; h: number }

function roundedRect(cr: any, x: number, y: number, w: number, h: number, r: number) {
    const PI = Math.PI
    cr.newPath()
    cr.arc(x + r,     y + r,     r, PI,        3 * PI / 2)
    cr.arc(x + w - r, y + r,     r, 3 * PI / 2, 2 * PI)
    cr.arc(x + w - r, y + h - r, r, 0,          PI / 2)
    cr.arc(x + r,     y + h - r, r, PI / 2,     PI)
    cr.closePath()
}

export function createSchematicMap(wsId: number, width: number): SchematicHandle {
    const initialHeight = Math.round(width * (9 / 16))

    // Cairo canvas draws background + tile rectangles at exact pixel coords.
    // CSS color: var(--crystal-surface) on this widget is read via get_color()
    // to get the actual surface color without hardcoding.
    const canvas = new Gtk.DrawingArea({
        css_classes: ["wo-schematic-canvas"],
        can_target: false,
        width_request: width,
        height_request: initialHeight,
    })

    // Gtk.Fixed positions transparent icon widgets over each tile
    const iconFixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-icons"],
        can_target: false,
        hexpand: true,
        vexpand: true,
    }) as any
    iconFixed.set_overflow(Gtk.Overflow.HIDDEN)

    // Overlay: canvas (base) + iconFixed (top layer)
    const overlay = new Gtk.Overlay({
        css_classes: ["wo-schematic-preview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
        width_request: width,
        height_request: initialHeight,
    })
    overlay.set_child(canvas)
    overlay.add_overlay(iconFixed)

    const HYPR_ROUNDING = 24

    let currentTiles: Tile[] = []
    let currentRadius   = 0

    canvas.set_draw_func((da, cr, areaW, areaH) => {
        if (areaW <= 0 || areaH <= 0) return
        // Dark background
        cr.setSourceRGBA(0, 0, 0, 0.3)
        cr.rectangle(0, 0, areaW, areaH)
        cr.fill()

        // Tile color: read from CSS 'color' property = var(--crystal-surface)
        const col = da.get_style_context().get_color()
        cr.setSourceRGBA(col.red, col.green, col.blue, col.alpha)
        for (const t of currentTiles) {
            const r = Math.min(currentRadius, t.w / 2, t.h / 2)
            roundedRect(cr, t.x, t.y, t.w, t.h, r)
            cr.fill()
        }
    })

    const winWidgets = new Map<string, { box: Gtk.Box; icon: Gtk.Image }>()

    const sync = () => {
        const workspaces = hs.workspaces
        const monitors   = hs.monitors
        const clients    = hs.clients

        const ws = workspaces.find((w: any) => w.id === wsId)

        let hMonitor: any = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        // monitor_id is a loose runtime fallback not in the Workspace typings.
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === ((ws as any)?.monitor_id ?? -1))
        if (!hMonitor && wsId === hs.focusedWorkspaceId) hMonitor = hs.focusedMonitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === wsId) ?? monitors[0]
        if (!hMonitor?.width) return

        const scaleFactor = hMonitor.scale || 1
        const logicalW    = hMonitor.width  / scaleFactor
        const logicalH    = hMonitor.height / scaleFactor
        const scale       = width / logicalW
        const drawH       = Math.round(logicalH * scale)

        overlay.set_size_request(width, drawH)
        canvas.set_size_request(width, drawH)

        const monX = hMonitor.x || 0
        const monY = hMonitor.y || 0

        const wsClients = clients
            .filter((c: any) => c?.workspace?.id === wsId)
            .sort((a: any, b: any) => (b.focus_history_id || 0) - (a.focus_history_id || 0))

        // rounding_power=3.2 makes corners look more rounded than the raw radius implies;
        // multiply by 4 to keep the schematic visually faithful at minimap scale
        currentRadius = HYPR_ROUNDING * 4 * scale

        // Cairo tiles — float coords so all inter-window gaps scale identically
        currentTiles = wsClients.map((c: any) => ({
            x: (c.x - monX) * scale,
            y: (c.y - monY) * scale,
            w: Math.max(1, c.width  * scale),
            h: Math.max(1, c.height * scale),
        }))
        canvas.queue_draw()

        // Icon widgets — transparent boxes with centered images
        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = winWidgets.get(addr)
                if (w) iconFixed.remove(w.box)
                winWidgets.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            const x = Math.round((c.x - monX) * scale)
            const y = Math.round((c.y - monY) * scale)
            const w = Math.max(2, Math.round(c.width  * scale))
            const h = Math.max(2, Math.round(c.height * scale))

            let widget = winWidgets.get(c.address)
            if (!widget) {
                const img = new Gtk.Image({
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true,
                })
                const box = new Gtk.Box({
                    css_classes: ["wo-schematic-icon"],
                    can_focus: false,
                    focusable: false,
                })
                box.append(img)
                iconFixed.put(box, x, y)
                widget = { box, icon: img }
                winWidgets.set(c.address, widget)
            } else {
                iconFixed.move(widget.box, x, y)
            }

            widget.box.set_size_request(w, h)

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

    return { wrapper: overlay, sync }
}
