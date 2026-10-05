import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import compositor, { bareAddr, FULLSCREEN } from "../../core/CompositorState"
import appService from "../../core/AppService"
import shellActions from "../../core/ShellActions"
import { t } from "../../core/i18n"
import { safeDisconnect } from "../../core/signals"
import { WS_COUNT } from "../../common/WorkspaceDot"
import { modeLabel } from "../../common/WorkspaceModeControl"
import { WORKSPACE_MODES } from "../../core/WorkspaceModes"
import { menuRow, menuHeader, menuSeparator, menuDisclosure } from "../../common/MenuRow"

// The AppTitle capsule's menu: the APP the capsule names and the window of it you are
// on — the visual gateway to window management for people who'd never learn the
// keybinds. Opens in the bar's shared expansion capsule (openCustomExpansion).
// Sections, top to bottom: the window's size and placement, where it goes (Move to
// Desktop), the app's Settings page, and closing — the window or the whole app.

export function buildWindowMenu(onClose: () => void): Gtk.Widget {
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        width_request: 230,
    })

    // Capture at open time — the menu acts on the window it was opened for.
    const client = compositor.focusedClient
    const wsId = compositor.focusedWorkspaceId

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
    // Read the RECONCILED focus (`compositor.focusedClient`), never `hl.focused_client` —
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
    const focusMoved = () => bareAddr((compositor.focusedClient as any)?.address) !== openedFor
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
        focusWatch = compositor.connect("changed", () => { if (focusMoved()) onClose() })
    })
    root.connect("unmap", () => {
        safeDisconnect(compositor, focusWatch)
        focusWatch = 0
    })

    if (client) {
        const addr = client.address
        const appName = appService.appNameForWindow(client)
        const appId = appService.appIdForWindow(client)

        // No header: the capsule this menu hangs from already names the app, one line up.

        // The window section fills when the authoritative state read lands (~ms).
        // NEVER build checks from AstalHyprland.Client props: floating/fullscreen
        // go stale there (a tiled window read floating=true after a float-all —
        // wrong checks + skipped windows, 2026-06-11).
        const windowSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
        root.append(windowSection)
        // Group section (Hyprland's tabs) — filled by the SAME authoritative read
        // (`grouped` lives in clients -j).
        const groupSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
        root.append(groupSection)
        const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a)
        // A tab is one window of a group, so it goes by its TITLE, which is what tells
        // two windows of one app apart.
        const labelFor = (memberAddr: string) => {
            const c = compositor.clients.find(c => norm(c.address) === memberAddr)
            return c ? (c.title || appService.appNameForWindow(c)) : memberAddr
        }
        compositor.readWindow(addr).then(json => {
            const floating = json ? !!json.floating : !!client.floating
            // `fullscreen` in clients -j is the FSMODE int (0 none / 1 maximized /
            // 2 fullscreen): each row checks its own mode, so a maximized window does
            // not read as fullscreen nor the other way round.
            const fsMode = json ? json.fullscreen : client.fullscreen
            const fullscreen = json ? json.fullscreen === FULLSCREEN : compositor.isRealFullscreen(client)

            // Size first — Minimize, Maximize, Full Screen: the order the title bar's own
            // buttons and every desktop's window menu put them in, smallest to largest.
            if (compositor.caps.minimize) {
                windowSection.append(menuRow({
                    label: t("bar.window-menu.minimize"),
                    onClick: () => { compositor.minimizeWindow(addr); onClose() },
                }))
            }
            windowSection.append(menuRow({
                label: t("bar.window-menu.maximize"),
                checked: fsMode === 1,
                onClick: () => { compositor.toggleMaximize(addr); onClose() },
            }))
            windowSection.append(menuRow({
                label: t("bar.window-menu.fullscreen"),
                checked: fullscreen,
                onClick: () => { compositor.toggleFullscreen(addr); onClose() },
            }))
            // Placement, its own question: floating or in the mosaic — two rows, the check
            // on the one it is (#513's rule: a lone "Floating" row is checked on every
            // window of a floating desktop and, pressed, does what it does not say). Either
            // way round on either kind of desktop: a floating desktop takes a window into
            // its mosaic and leaves the rest free. The words are the desktop mode's own.
            windowSection.append(menuSeparator())
            for (const mode of WORKSPACE_MODES) {
                const here = (mode === "floating") === floating
                windowSection.append(menuRow({
                    label: modeLabel(mode),
                    checked: here,
                    onClick: () => {
                        if (!here) {
                            if (mode === "floating") compositor.enableFloatWindow(addr)
                            else compositor.tileWindow(addr)
                        }
                        onClose()
                    },
                }))
            }
            if (floating) {
                windowSection.append(menuRow({
                    label: t("bar.window-menu.center"),
                    onClick: () => { compositor.centerWindow(addr); onClose() },
                }))
                windowSection.append(menuRow({
                    label: t("bar.window-menu.pin"),
                    checked: json ? !!json.pinned : false,
                    onClick: () => { compositor.togglePin(addr); onClose() },
                }))
            }

            // --- Group (tabs) --- only where the compositor has them (`caps.groups`):
            // Hyalo has none, by the owner's decision (2026-10-01).
            // `grouped` = member addresses in tab order; the menu's window is
            // the active tab (it's focused). Clicking another member focuses
            // it, which IS the tab switch. No "move into group" row:
            // `into_group` only acts on the focused window and needs a
            // direction — grouping is done by drag or keybind.
            const grouped: string[] = (json?.grouped ?? []) as string[]
            const self = norm(addr)
            if (!compositor.caps.groups) {
                // Nothing to offer: the section stays empty.
            } else if (grouped.length > 0) {
                groupSection.append(menuSeparator())
                groupSection.append(menuHeader(`${t("bar.window-menu.group")} — ${grouped.length}`))
                for (const member of grouped) {
                    groupSection.append(menuRow({
                        label: labelFor(member),
                        // Window titles are arbitrarily long; the menu is fixed at
                        // 230, so ellipsize rather than let a tab label widen it.
                        ellipsize: true,
                        checked: member === self,
                        onClick: () => { if (member !== self) compositor.focusWindow(member); onClose() },
                    }))
                }
                if (grouped.length > 1) {
                    groupSection.append(menuRow({
                        label: t("bar.window-menu.group.move-out"),
                        onClick: () => { compositor.moveOutOfGroup(addr); onClose() },
                    }))
                }
                groupSection.append(menuRow({
                    label: t("bar.window-menu.group.ungroup"),
                    onClick: () => { compositor.toggleGroup(addr); onClose() },
                }))
            } else {
                groupSection.append(menuSeparator())
                groupSection.append(menuRow({
                    label: t("bar.window-menu.group.create"),
                    onClick: () => { compositor.toggleGroup(addr); onClose() },
                }))
            }
        })

        root.append(menuSeparator())

        // Move to Desktop: opens in place onto the desktops the window can go to — every
        // one but its own. A disclosure rather than a strip of numbers, so the row reads
        // as words like the rest, and the list is free to change length (#740, dynamic
        // desktops) without the menu changing shape.
        root.append(menuDisclosure({
            label: t("bar.window-menu.move-to"),
            build: () => {
                const rows: Gtk.Widget[] = []
                for (let i = 1; i <= WS_COUNT; i++) {
                    if (i === wsId) continue
                    rows.push(menuRow({
                        label: `${t("overview.workspace")} ${i}`,
                        onClick: () => { compositor.sendToWorkspace(addr, i); onClose() },
                    }))
                }
                return rows
            },
        }))

        // The app's own page in Settings — only for an app that has one (an entry the
        // app grid lists). Ellipsis: it opens a window rather than acting.
        if (appId && appService.getAppData(appId)?.visible) {
            root.append(menuSeparator())
            root.append(menuRow({
                label: t("bar.window-menu.app-settings"),
                onClick: () => { onClose(); shellActions.openAppSettings?.(appId) },
            }))
        }

        // Last, where a slip of the pointer costs the least to reach for by mistake.
        // Quit closes EVERY window of the app, exactly what the dock's Quit does — an
        // app that keeps running in the tray keeps running, as it would with its own
        // close buttons.
        root.append(menuSeparator())
        root.append(menuRow({
            label: t("bar.window-menu.close"),
            onClick: () => { compositor.closeWindow(addr); onClose() },
        }))
        root.append(menuRow({
            label: t("bar.window-menu.quit").replace("%s", appName),
            ellipsize: true,
            onClick: () => {
                const app = appService.resolveWindowApp(client.class || "")
                for (const c of compositor.clients) {
                    if (appService.resolveWindowApp(c.class || "") === app) compositor.closeWindow(c.address)
                }
                onClose()
            },
        }))
    }

    // No "else": with no window focused the capsule names the desktop and opens no menu
    // (AppTitle). The desktop's MODE (#513) is not here either: it belongs to the
    // desktop, not to an app, and lives where the desktops are — the overview the dots
    // open, one badge per desktop — and in Settings.

    return root
}

export default buildWindowMenu
