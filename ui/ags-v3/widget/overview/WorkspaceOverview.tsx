import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import status from "../../core/Status"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import { t } from "../../core/i18n"
import { createSchematicMap } from "../common/WorkspaceSchematic"

const WO_PREVIEW_WIDTH = 300

export default function WorkspaceOverview(monitor: any) {
    const hyprland = AstalHyprland.get_default()

    const overview = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["workspace-overview"],
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
    
    // SquircleContainer wraps the entire overview, providing a unified glass background
    const overviewSquircle = SquircleContainer({
        child: overview,
        n: 3.2,
        radius: 36,
        useShellOpacity: true,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.1 }
    })
    
    windowContent.append(overviewSquircle)

    const list = new Gtk.Grid({
        column_spacing: 16,
        row_spacing: 16,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { wrapperBtn: Gtk.Button, itemBox: Gtk.Box, schematic: ((ws: any[], mon: any[], cl: any[]) => void) | null, headerBox: Gtk.Box }>()

    for (let i = 1; i <= 5; i++) {
        const schematic = createSchematicMap(i, WO_PREVIEW_WIDTH, hyprland)
        const label = new Gtk.Label({ label: `${t("overview.workspace")} ${i}`, css_classes: ["wo-label"] })
        const count = new Gtk.Label({ css_classes: ["wo-count"] })
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            halign: Gtk.Align.CENTER,
            margin_bottom: 4
        })
        header.append(label); header.append(count)

        const itemBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ["wo-item"],
            width_request: WO_PREVIEW_WIDTH + 24,
            hexpand: false
        })
        itemBox.append(header); itemBox.append(schematic.wrapper)

        const btn = new Gtk.Button({ child: itemBox, css_classes: ["wo-btn"] })
        btn.set_focus_on_click(false) 
        btn.connect("clicked", () => {
            execAsync(["hyprctl", "dispatch", "workspace", `${i}`]).catch(console.error)
            status.overview_open = false
        })

        slots.set(i, { wrapperBtn: btn, itemBox: itemBox, schematic: schematic.sync, headerBox: header })
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
            const occupied = new Set(workspaces.filter(ws => ws != null).map(ws => ws.id))

            slots.forEach((ctx, i) => {
                const isActive = focusedId === i
                const isOccupied = occupied.has(i)
                ctx.wrapperBtn.visible = true

                const label = ctx.headerBox.get_first_child() as Gtk.Label
                const count = ctx.headerBox.get_last_child() as Gtk.Label

                if (ctx.itemBox && ctx.itemBox.set_css_classes) {
                    ctx.itemBox.set_css_classes(["wo-item", isActive ? "active" : ""])
                }
                label.set_css_classes(["wo-label", isActive ? "active" : ""])

                const wsClients = clients.filter(c => c?.workspace?.id === i)
                count.label = wsClients.length === 0 ? t("overview.empty") : (wsClients.length === 1 ? `1 ${t("overview.window")}` : `${wsClients.length} ${t("overview.windows")}`)

                if (ctx.schematic) {
                    ctx.schematic(workspaces, monitors, clients)
                }
            })
        } catch (e) {
            console.error(`[WO-Error] syncAll failed: ${e}`)
        }
    }


    const signals = [
        hyprland.connect("notify::focused-workspace", () => {
            syncAll()
        }),
        hyprland.connect("notify::clients", () => {
            syncAll()
        }),
        hyprland.connect("monitor-added", () => syncAll()),
        hyprland.connect("monitor-removed", () => syncAll()),
        hyprland.connect("event", (h, name, data) => {
            if (["workspace", "activewindow", "movewindow", "resizewindow", "openwindow", "closewindow", "fullscreen", "focusedmon"].includes(name)) {
                syncAll()
            }
        })
    ]

    status.connect("notify::overview-open", () => {
        if (status.overview_open) {
            syncAll()
        }
    })

    // V8.0: On-demand heartbeat — only runs while overview is open, stops automatically when closed.
    // Hyprland event signals handle real-time changes; this acts as a safety net for edge cases.
    const scheduleHeartbeat = () => {
        GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
            if (!status.overview_open) return GLib.SOURCE_REMOVE
            syncAll()
            return GLib.SOURCE_CONTINUE
        })
    }
    status.connect("notify::overview-open", () => {
        if (status.overview_open) scheduleHeartbeat()
    })

    windowContent.connect("unrealize", () => {
        signals.forEach(id => hyprland.disconnect(id))
    })

    overview.append(list)

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncAll()
        return GLib.SOURCE_REMOVE
    })

    return windowContent
}
