import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import status from "../../core/Status"
import SquircleContainer, { Shape } from "../../common/SquircleContainer"
import { t } from "../../core/i18n"
import { createSchematicMap } from "../../common/WorkspaceSchematic"
import hs from "../../core/HyprlandState"
import { safeDisconnect } from "../../core/signals"

const WO_PREVIEW_WIDTH = 300

export default function WorkspaceOverview(monitor: any) {
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
        radius: 64,
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

    const slots = new Map<number, { wrapperBtn: Gtk.Button, itemBox: Gtk.Box, schematic: (() => void) | null, headerBox: Gtk.Box }>()

    // Keyboard-focused slot (1..5), -1 = keyboard nav idle. Set on open to the
    // active workspace; moved by ←/→; committed by Enter. Purely a visual cursor
    // (the `keyboard-focus` class) — we never grab GTK focus, so the bar's
    // CAPTURE-phase key controller owns navigation the same way Prism does.
    let navIdx = -1
    const WS_COUNT = 5

    for (let i = 1; i <= 5; i++) {
        const schematic = createSchematicMap(i, WO_PREVIEW_WIDTH)
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
            hs.focusWorkspace(i)
            status.overview_open = false
        })

        slots.set(i, { wrapperBtn: btn, itemBox: itemBox, schematic: schematic.sync, headerBox: header })
        const col = (i - 1) % 5
        const row = Math.floor((i - 1) / 5)
        list.attach(btn, col, row, 1, 1)
    }

    const syncAll = () => {
        try {
            const monitors   = hs.monitors
            const workspaces = hs.workspaces
            const clients    = hs.clients
            const focusedId  = hs.focusedWorkspace?.id || 1
            const occupied   = hs.occupiedWorkspaces

            slots.forEach((ctx, i) => {
                const isActive   = focusedId === i
                const isOccupied = occupied.has(i)
                ctx.wrapperBtn.visible = true

                const label = ctx.headerBox.get_first_child() as Gtk.Label
                const count = ctx.headerBox.get_last_child() as Gtk.Label

                if (ctx.itemBox && ctx.itemBox.set_css_classes) {
                    ctx.itemBox.set_css_classes(["wo-item", isActive ? "active" : "", navIdx === i ? "keyboard-focus" : ""])
                }
                label.set_css_classes(["wo-label", isActive ? "active" : ""])

                const wsClients = clients.filter(c => c?.workspace?.id === i)
                count.label = wsClients.length === 0 ? t("overview.empty") : (wsClients.length === 1 ? `1 ${t("overview.window")}` : `${wsClients.length} ${t("overview.windows")}`)

                if (ctx.schematic) ctx.schematic()
            })
        } catch (e) {
            console.error(`[WO-Error] syncAll failed: ${e}`)
        }
    }


    // Only re-sync while the overview is actually open. syncAll churns per-window
    // icon widgets and queue_draw()s every workspace schematic; running it on every
    // HyprlandState "changed" while the overview is CLOSED needlessly repaints the bar
    // window each event (a real cost when "changed" storms — see tech-debt #11). The
    // overview is re-synced on open via notify::overview-open below.
    const changedId = hs.connect("changed", () => { if (status.overview_open) syncAll() })

    status.connect("notify::overview-open", () => {
        if (status.overview_open) syncAll()
    })

    windowContent.connect("unrealize", () => {
        safeDisconnect(hs, changedId)
    })

    overview.append(list)

    // Lightweight repaint for arrow-key moves: only toggles the cursor class, no
    // schematic rebuild (unlike syncAll). add/remove so it never wipes `active`.
    const refreshKbFocus = () => {
        slots.forEach((ctx, i) => {
            if (navIdx === i) ctx.itemBox.add_css_class("keyboard-focus")
            else ctx.itemBox.remove_css_class("keyboard-focus")
        })
    }

    // Nav API consumed by the bar's key controller (see Bar.tsx). onOpen seeds the
    // cursor on the active workspace each time the overview is shown.
    ;(windowContent as any).onOpen = () => {
        navIdx = hs.focusedWorkspace?.id || 1
        refreshKbFocus()
    }
    ;(windowContent as any).handleKey = (keyval: number): boolean => {
        if (keyval === Gdk.KEY_Escape) { status.overview_open = false; return true }
        if (keyval === Gdk.KEY_Left)  { if (navIdx > 1)        { navIdx--; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Right) { if (navIdx < WS_COUNT) { navIdx++; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (navIdx >= 1) { hs.focusWorkspace(navIdx); status.overview_open = false }
            return true
        }
        return false
    }

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncAll()
        return GLib.SOURCE_REMOVE
    })

    return windowContent
}
