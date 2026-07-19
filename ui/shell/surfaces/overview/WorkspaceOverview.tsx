import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import status, { ISLAND_OVERVIEW } from "../../core/Status"
import SquircleContainer from "../../common/SquircleContainer"
import { t } from "../../core/i18n"
import { createSchematicMap } from "../../common/WorkspaceSchematic"
import hs from "../../core/HyprlandState"
import { safeDisconnect } from "../../core/signals"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"

const WO_PREVIEW_WIDTH = 300

// Glass recipe for the island container — exported so the bar's MorphRevealer
// paints its interpolated Cairo clone with the exact same params and the
// handoff at the morph's endpoints is pixel-perfect (see MorphRevealer.ts).
export const WO_GLASS = { radius: 64, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

export default function WorkspaceOverview() {
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
        n: WO_GLASS.n,
        radius: WO_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: WO_GLASS.border
    })

    windowContent.append(overviewSquircle)

    const list = new Gtk.Grid({
        column_spacing: 16,
        row_spacing: 16,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { itemBox: Gtk.Box, label: Gtk.Label, count: Gtk.Label, schematic: () => void }>()

    // Keyboard-focused slot (1..WS_COUNT), -1 = keyboard nav idle. Set on open to
    // the active workspace; moved by ←/→; committed by Enter. Purely a visual
    // cursor (the `keyboard-focus` class) — we never grab GTK focus, so the bar's
    // CAPTURE-phase key controller owns navigation the same way Prism does.
    let navIdx = -1

    // Each card carries the SAME state dot as the bar capsule (shared
    // makeWorkspaceDot, identical CSS): the morph's traveling ghosts land
    // exactly on these — the capsule's dot row fans out into the card headers.
    const cardDots: Gtk.Widget[] = []

    for (let i = 1; i <= WS_COUNT; i++) {
        const schematic = createSchematicMap(i, WO_PREVIEW_WIDTH)
        const dot = makeWorkspaceDot(i)
        dot.halign = Gtk.Align.CENTER
        dot.margin_bottom = 2
        cardDots.push(dot)
        const label = new Gtk.Label({ label: `${t("overview.workspace")} ${i}`, css_classes: ["wo-label"] })
        const count = new Gtk.Label({ css_classes: ["wo-count"] })
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            halign: Gtk.Align.CENTER,
            margin_bottom: 4
        })
        header.append(dot); header.append(label); header.append(count)

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
            status.island_mode = ""
        })

        slots.set(i, { itemBox, label, count, schematic: schematic.sync })
        const col = (i - 1) % WS_COUNT
        const row = Math.floor((i - 1) / WS_COUNT)
        list.attach(btn, col, row, 1, 1)
    }

    const syncAll = () => {
        try {
            const focusedId = hs.focusedWorkspace?.id || 1
            // One pass over the client list instead of a filter per slot.
            const countByWs = new Map<number, number>()
            for (const c of hs.clients) {
                const id = c?.workspace?.id
                if (typeof id === "number") countByWs.set(id, (countByWs.get(id) ?? 0) + 1)
            }

            slots.forEach((ctx, i) => {
                const isActive = focusedId === i
                ctx.itemBox.set_css_classes(["wo-item", isActive ? "active" : "", navIdx === i ? "keyboard-focus" : ""])
                ctx.label.set_css_classes(["wo-label", isActive ? "active" : ""])

                const n = countByWs.get(i) ?? 0
                ctx.count.label = n === 0 ? t("overview.empty") : (n === 1 ? `1 ${t("overview.window")}` : `${n} ${t("overview.windows")}`)

                ctx.schematic()
            })
        } catch (e) {
            console.error(`[WO-Error] syncAll failed: ${e}`)
        }
    }


    // Only re-sync while the overview is actually open. syncAll churns per-window
    // icon widgets and queue_draw()s every workspace schematic; running it on every
    // HyprlandState "changed" while the overview is CLOSED needlessly repaints the bar
    // window each event (a real cost when "changed" storms — see tech-debt #11). The
    // overview is re-synced on open via notify::island-mode below.
    const isOpen = () => status.island_mode === ISLAND_OVERVIEW
    const changedId = hs.connect("changed", () => { if (isOpen()) syncAll() })

    status.connect("notify::island-mode", () => {
        if (isOpen()) syncAll()
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
        if (keyval === Gdk.KEY_Escape) { status.island_mode = ""; return true }
        if (keyval === Gdk.KEY_Left)  { if (navIdx > 1)        { navIdx--; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Right) { if (navIdx < WS_COUNT) { navIdx++; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (navIdx >= 1) { hs.focusWorkspace(navIdx); status.island_mode = "" }
            return true
        }
        // 1..5 (top row or keypad) jump straight to that workspace — same muscle
        // memory as the Super+N binds, no cursor dance.
        const digit = keyval >= Gdk.KEY_1 && keyval < Gdk.KEY_1 + WS_COUNT ? keyval - Gdk.KEY_0
                    : keyval >= Gdk.KEY_KP_1 && keyval < Gdk.KEY_KP_1 + WS_COUNT ? keyval - Gdk.KEY_KP_0
                    : 0
        if (digit) { hs.focusWorkspace(digit); status.island_mode = ""; return true }
        return false
    }

    // Morph handles for the bar's MorphRevealer (see common/MorphRevealer.ts):
    // - morphContent: the content layer (labels + schematics) that fades in
    //   over the last stretch of the capsule→island morph;
    // - morphGlass: the glass container — final rect of the interpolated
    //   squircle, and its `.glassArea` is suppressed mid-morph so the painted
    //   clone owns the shape;
    // - morphDots: the card dots the traveling ghosts land on.
    ;(windowContent as any).morphContent = overview
    ;(windowContent as any).morphGlass = overviewSquircle
    ;(windowContent as any).morphDots = cardDots

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncAll()
        return GLib.SOURCE_REMOVE
    })

    return windowContent
}
