import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import hs, { bareAddr } from "../../core/HyprlandState"
import { t } from "../../core/i18n"
import { getWordmark } from "../../utils"
import { safeDisconnect } from "../../core/signals"
import { menuRow, menuHeader, menuSeparator } from "../../common/MenuRow"

// Window-options menu for the AppTitle capsule — the visual gateway to Hyprland's
// window management for people who'd never learn the keybinds. Opens in the bar's
// shared expansion capsule (openCustomExpansion). Sections: window actions,
// move-to-workspace strip, group/tabs (v2), workspace actions.

const WORKSPACE_COUNT = 5   // matches Workspaces.tsx

export function buildWindowMenu(onClose: () => void): Gtk.Widget {
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        width_request: 230,
    })

    // Capture at open time — the menu acts on the window it was opened for.
    const client = hs.focusedClient
    const wsId = hs.focusedWorkspaceId

    // ── Stale-focus guard ──────────────────────────────────────────────────────
    // Every row below closes over the address captured above: this menu acts on ONE
    // window and cannot re-target itself mid-flight. If focus moves while it is up
    // (Alt+Tab is the everyday case — the compositor moves focus with no click at
    // all, so the bar's focus grab is never cleared and nothing dismisses us), the
    // AppTitle capsule renames itself to the NEW window while the menu keeps acting
    // on the old one: one label naming two different windows, and rows whose checks
    // describe neither. Rebuilding in place is not the answer — the panel would
    // mutate under a pointer already travelling toward a row. So: close.
    //
    // Read the RECONCILED focus (`hs.focusedClient`), never `hl.focused_client` —
    // acquiring the grab can make the compositor announce "no active window", and
    // the raw answer would read that silence as a focus change and close us at open.
    // For the same reason this hangs off `changed`, which only fires when the
    // structural signature (focus included) actually moved.
    //
    // Lifetime is the widget's: the expansion rebuilds its content on every open, so
    // map→unmap brackets exactly one showing of this menu, and a bar that hides
    // (fullscreen chrome-hiding) re-checks on the way back rather than acting on a
    // change it slept through.
    const openedFor = bareAddr((client as any)?.address)
    let focusWatch = 0
    const focusMoved = () => bareAddr((hs.focusedClient as any)?.address) !== openedFor
    root.connect("map", () => {
        // Deferred: on the FIRST map we are inside showExpansion's own set_visible,
        // and closing from there would re-enter it (hide racing the reveal it is
        // still about to schedule). Idle also costs nothing — a focus change cannot
        // land between building this menu and mapping it (same call stack), so the
        // catch-up only ever fires on a RE-map, after the bar came back.
        if (focusMoved()) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onClose(); return GLib.SOURCE_REMOVE })
            return
        }
        if (focusWatch) return
        focusWatch = hs.connect("changed", () => { if (focusMoved()) onClose() })
    })
    root.connect("unmap", () => {
        safeDisconnect(hs, focusWatch)
        focusWatch = 0
    })

    if (client) {
        const addr = client.address

        root.append(menuHeader(getWordmark(client, hs.focusedWorkspace) || client.title || "", true))

        // The window section fills when the authoritative state read lands (~ms).
        // NEVER build checks from AstalHyprland.Client props: floating/fullscreen
        // go stale there (a tiled window read floating=true after a float-all —
        // wrong checks + skipped windows, 2026-06-11).
        const windowSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
        root.append(windowSection)
        // Group section (v2) — appended into the slot after the move-to strip,
        // filled by the SAME authoritative read (`grouped` lives in clients -j).
        const groupSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
        const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a)
        // Astal client lookup is for IDENTITY only (title/class for the tab
        // label) — never for window state. Read from HyprlandState's cache.
        const labelFor = (memberAddr: string) => {
            const c = hs.clients.find(c => norm(c.address) === memberAddr)
            return c ? (getWordmark(c, hs.focusedWorkspace) || c.title || c.class) : memberAddr
        }
        hs.getClientJson(addr).then(json => {
            const floating = json ? !!json.floating : !!client.floating
            // `fullscreen` in clients -j is the FSMODE int (0 none / 1 maximized /
            // 2 fullscreen); the row's toggle acts on REAL fullscreen, so only
            // mode 2 checks it — maximize (Super+M) must not read as fullscreen.
            const fullscreen = json ? json.fullscreen === 2 : hs.isRealFullscreen(client)

            windowSection.append(menuRow({
                label: t("bar.window-menu.float"),
                checked: floating,
                onClick: () => { hs.floatWindow(addr); onClose() },
            }))
            // Pseudo state isn't readable (no `pseudo` in clients -j nor
            // HL.Window), so this row is a plain toggle with no check.
            windowSection.append(menuRow({
                label: t("bar.window-menu.pseudo"),
                onClick: () => { hs.togglePseudo(addr); onClose() },
            }))
            windowSection.append(menuRow({
                label: t("bar.window-menu.fullscreen"),
                checked: fullscreen,
                onClick: () => { hs.toggleFullscreen(addr); onClose() },
            }))
            if (floating) {
                windowSection.append(menuRow({
                    label: t("bar.window-menu.center"),
                    onClick: () => { hs.centerWindow(addr); onClose() },
                }))
                windowSection.append(menuRow({
                    label: t("bar.window-menu.pin"),
                    checked: json ? !!json.pinned : false,
                    onClick: () => { hs.togglePin(addr); onClose() },
                }))
            }

            // --- Group (tabs) ---
            // `grouped` = member addresses in tab order; the menu's window is
            // the active tab (it's focused). Clicking another member focuses
            // it, which IS the tab switch. No "move into group" row:
            // `into_group` only acts on the focused window and needs a
            // direction — grouping is done by drag or keybind.
            const grouped: string[] = (json?.grouped ?? []) as string[]
            const self = norm(addr)
            if (grouped.length > 0) {
                groupSection.append(menuHeader(`${t("bar.window-menu.group")} — ${grouped.length}`))
                for (const member of grouped) {
                    groupSection.append(menuRow({
                        label: labelFor(member),
                        // Window titles are arbitrarily long; the menu is fixed at
                        // 230, so ellipsize rather than let a tab label widen it.
                        ellipsize: true,
                        checked: member === self,
                        onClick: () => { if (member !== self) hs.focusWindow(member); onClose() },
                    }))
                }
                if (grouped.length > 1) {
                    groupSection.append(menuRow({
                        label: t("bar.window-menu.group.move-out"),
                        onClick: () => { hs.moveOutOfGroup(addr); onClose() },
                    }))
                }
                groupSection.append(menuRow({
                    label: t("bar.window-menu.group.ungroup"),
                    onClick: () => { hs.toggleGroup(addr); onClose() },
                }))
                groupSection.append(menuSeparator())
            } else {
                groupSection.append(menuRow({
                    label: t("bar.window-menu.group.create"),
                    onClick: () => { hs.toggleGroup(addr); onClose() },
                }))
                groupSection.append(menuSeparator())
            }
        })

        root.append(menuSeparator())

        // Move-to-workspace: inline 1..5 strip (one tap, current one disabled) —
        // the expansion capsule has no nested-submenu machinery, and at 5 fixed
        // workspaces a strip beats a submenu anyway.
        root.append(menuHeader(t("bar.window-menu.move-to")))
        const wsRow = new Gtk.Box({ spacing: 8, css_classes: ["window-menu-ws-row"], margin_start: 8, margin_end: 8 })
        for (let i = 1; i <= WORKSPACE_COUNT; i++) {
            const btn = new Gtk.Button({
                label: String(i),
                css_classes: ["window-menu-ws-btn", ...(i === wsId ? ["current"] : [])],
                sensitive: i !== wsId,
                hexpand: true,
            })
            btn.connect("clicked", () => { hs.sendToWorkspace(addr, i); onClose() })
            wsRow.append(btn)
        }
        root.append(wsRow)

        root.append(menuSeparator())
        root.append(groupSection)
    } else {
        root.append(menuHeader(t("bar.window-menu.no-window")))
        root.append(menuSeparator())
    }

    // Workspace section — always shown
    root.append(menuHeader(`${t("bar.window-menu.workspace")} ${wsId}`))
    root.append(menuRow({
        label: t("bar.window-menu.float-all"),
        onClick: () => { hs.floatAllInWorkspace(wsId); onClose() },
    }))

    return root
}

export default buildWindowMenu
