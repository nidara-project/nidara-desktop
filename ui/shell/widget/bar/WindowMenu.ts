import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import hs from "../../core/HyprlandState"
import { t } from "../../core/i18n"
import { getWordmark } from "../../utils"
import { menuRow, menuHeader, menuSeparator } from "../common/MenuRow"

// Window-options menu for the AppTitle capsule — the visual gateway to Hyprland's
// window management for people who'd never learn the keybinds. Opens in the bar's
// shared expansion capsule (openCustomExpansion); built section-by-section so a
// groups/tabs section can slot in for v2 between "move to" and the workspace part.

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

    if (client) {
        const addr = client.address

        root.append(menuHeader(getWordmark(client, AstalHyprland.get_default()) || client.title || ""))

        // The window section fills when the authoritative state read lands (~ms).
        // NEVER build checks from AstalHyprland.Client props: floating/fullscreen
        // go stale there (a tiled window read floating=true after a float-all —
        // wrong checks + skipped windows, 2026-06-11).
        const windowSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
        root.append(windowSection)
        hs.getClientJson(addr).then(json => {
            const floating = json ? !!json.floating : !!client.floating
            const fullscreen = json ? !!json.fullscreen : !!(client.fullscreen as any)

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
        })

        root.append(menuSeparator())

        // Move-to-workspace: inline 1..5 strip (one tap, current one disabled) —
        // the expansion capsule has no nested-submenu machinery, and at 5 fixed
        // workspaces a strip beats a submenu anyway.
        root.append(menuHeader(t("bar.window-menu.move-to")))
        const wsRow = new Gtk.Box({ spacing: 6, css_classes: ["window-menu-ws-row"], margin_start: 8, margin_end: 8 })
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
        // (v2: groups/tabs section slots in here — hl.dsp.group.* is already
        // wired in HyprlandState, `grouped` comes from the same getClientJson read)
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
