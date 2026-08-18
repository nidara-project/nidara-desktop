import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { NidaraScrolled } from "../../../lib/nidara-kit"
import { execAsync } from "../../../lib/process"
import GLib from "gi://GLib"
// @ts-ignore
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import hs from "../../core/HyprlandState"
import appService, { type AppData } from "../../core/AppService"
import { pinnedState, savePinned } from "../dock/state"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { ScaleRevealer, OVERLAY_POP } from "../../common/ScaleRevealer"
import SquircleContainer from "../../common/SquircleContainer"
import { RADIUS, rowInsetFor } from "../../../lib/tokens"
import Theme from "../../core/ThemeManager"
import Cairo from "gi://cairo"
import shellActions from "../../core/ShellActions"
import { createSchematicMap } from "../../common/WorkspaceSchematic"
import { safeDisconnect } from "../../core/signals"
import { attachTooltip } from "../../common/Tooltip"
import { renderMenuModel } from "../../common/NidaraMenu"
import { sideFor, paintGlassBubble, ARROW_H, BUF, type ArrowSide } from "../../common/GlassBubble"

// Extract just the desktop basename, stripping path and .desktop extension
const normId = (s: string) => {
    const base = (s || "").split("/").pop() || s || ""
    return base.toLowerCase().replace(/\.desktop$/, "")
}

export interface AppGridPanelHandle {
    widget: Gtk.Widget
    /** The squircle's own `Gtk.DrawingArea` (`SquircleContainer`'s `glassArea`), so the
     *  owning surface can re-stamp its regions when the panel RESIZES. It does resize:
     *  `filterApps` swaps the fixed-height scroller for the short no-results box. Same
     *  hook `Bar.tsx` uses on the island capsule, and generic — it fires for any future
     *  cause too, not just that one. */
    glassArea: Gtk.Widget | null
    onShow: () => void
    handleKey: (keyval: number) => boolean
    setActive: (active: boolean) => void
    setVisible: (open: boolean, onDone?: () => void) => void
}

export default function AppGridPanel(
    monitor: Gdk.Monitor,
    onClose: () => void,
    /** Switch workspace WITHOUT this surface's focus grab undoing it — the dock owns
     *  the grab, `HyprlandState.focusWorkspaceFromShell` owns the order. Never call
     *  `hs.focusWorkspace` directly from here. */
    switchWorkspace: (id: number) => void,
): AppGridPanelHandle {
    // ── Search bar ─────────────────────────────────────────────────────────
    const searchEntry = new Gtk.Text({
        placeholder_text: t("app-grid.search.placeholder"),
        css_classes: ["app-grid-search-entry"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchBox = new Gtk.Box({
        css_classes: ["app-grid-search-box"],
        spacing: 12,
        hexpand: true,
    })
    searchBox.append(new Gtk.Image({ gicon: Icons.search, pixel_size: 18, css_classes: ["app-grid-search-icon", "nd-icon"] }))
    searchBox.append(searchEntry)

    // Typing reaches the grid's WINDOW-level key handler, not the entry — the focus
    // grab routes it there so the same keystroke can drive grid navigation — so the
    // characters are pushed into the BUFFER by hand (see handleKey). A buffer write
    // does not move the caret: GtkEntryBuffer has no cursor, and `Gtk.Text` only
    // advances its own position from its own editing path. The letters landed
    // correctly and the caret sat at column 0 forever (user-caught 2026-08-10).
    // Every buffer mutation goes through these two so it cannot be forgotten again;
    // -1 is GtkEditable for "after the last character".
    const searchInsert = (ch: string) => {
        const buf = searchEntry.get_buffer()
        buf.insert_text(buf.get_length(), ch, 1)
        searchEntry.set_position(-1)
    }
    const searchBackspace = () => {
        const buf = searchEntry.get_buffer()
        const len = buf.get_length()
        if (len > 0) buf.delete_text(len - 1, 1)
        searchEntry.set_position(-1)
    }

    const searchBoxClick = new Gtk.GestureClick()
    searchBoxClick.connect("pressed", () => {
        searchBox.add_css_class("search-active")
        searchEntry.grab_focus()
    })
    searchBox.add_controller(searchBoxClick)

    // ── Workspace strip ────────────────────────────────────────────────────
    const WS_STRIP_WIDTH = 150

    const wsStrip = new Gtk.Box({
        css_classes: ["ws-strip"],
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        hexpand: true,
        margin_bottom: 12,
    })

    interface WsSlot {
        itemBox: Gtk.Box
        label: Gtk.Label
        sync: () => void
    }
    const wsSlots = new Map<number, WsSlot>()
    // 0 = not in strip; 1-5 = keyboard-focused slot
    let wsNav = 0

    const syncWsStrip = () => {
        try {
            const focusedId = hs.focusedWorkspaceId || 1
            wsSlots.forEach(({ itemBox, label, sync }, i) => {
                const isActive = focusedId === i
                const isNav    = wsNav === i
                if (isActive) itemBox.add_css_class("active")
                else          itemBox.remove_css_class("active")
                if (isNav)    itemBox.add_css_class("keyboard-focus")
                else          itemBox.remove_css_class("keyboard-focus")
                if (isActive) label.add_css_class("active")
                else          label.remove_css_class("active")
                sync()
            })
        } catch (e) {
            console.error(`[WsStrip] sync failed: ${e}`)
        }
    }

    // Keyboard-focus a specific slot (1-5); clears app-grid selection
    const focusWsSlot = (wsId: number) => {
        wsNav = Math.max(1, Math.min(wsId, 5))
        syncWsStrip()
        searchBox.remove_css_class("search-active")
        // Drop the top-result ring: while the strip holds the cursor, Enter
        // switches workspace, so a ringed app would be advertising the wrong key.
        flowbox.unselect_all()
    }

    const clearWsNav = () => {
        if (wsNav === 0) return
        wsNav = 0
        syncWsStrip()
    }

    for (let i = 1; i <= 5; i++) {
        const { wrapper, sync } = createSchematicMap(i, WS_STRIP_WIDTH)
        const wsLabel = new Gtk.Label({
            label: `${i}`,
            css_classes: ["ws-strip-label"],
            halign: Gtk.Align.CENTER,
        })
        const itemBox = new Gtk.Box({
            css_classes: ["ws-strip-item"],
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            halign: Gtk.Align.FILL,
        })
        itemBox.append(wrapper)
        itemBox.append(wsLabel)

        // Hover highlight
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => itemBox.add_css_class("hover"))
        motion.connect("leave", () => itemBox.remove_css_class("hover"))
        itemBox.add_controller(motion)

        // Click: switch workspace and move keyboard focus here
        const click = new Gtk.GestureClick()
        click.connect("released", () => {
            switchWorkspace(i)
            focusWsSlot(i)
        })
        itemBox.add_controller(click)

        wsSlots.set(i, { itemBox, label: wsLabel, sync })
        wsStrip.append(itemBox)
    }

    const stripChangedId = hs.connect("changed", () => {
        if (wsNav > 0) wsNav = hs.focusedWorkspaceId || 1
        syncWsStrip()
    })
    wsStrip.connect("unrealize", () => safeDisconnect(hs, stripChangedId))
    // hs emits "changed" in its constructor before AppGrid connects — do an
    // initial sync on the next idle tick so schematics are populated immediately.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { syncWsStrip(); return GLib.SOURCE_REMOVE })

    // ── FlowBox ────────────────────────────────────────────────────────────
    const GRID_COLS = 6
    const flowbox = new Gtk.FlowBox({
        name: "app-grid-flowbox",
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
        hexpand: true,
        max_children_per_line: GRID_COLS,
        min_children_per_line: 3,
        selection_mode: Gtk.SelectionMode.SINGLE,
        column_spacing: 8,
        row_spacing: 8,
        margin_top: 8,
        margin_bottom: 8,
        css_classes: ["app-grid-flow"],
        can_focus: true,
        homogeneous: true,
    })

    // ── No results ─────────────────────────────────────────────────────────
    const noResults = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        vexpand: true,
        spacing: 12,
        visible: false,
    })
    const noResultsIcon = new Gtk.Image({
        gicon: Icons.search,
        pixel_size: 48,
        css_classes: ["app-grid-no-results-icon", "nd-icon"],
    })
    const noResultsLabel = new Gtk.Label({
        label: t("app-grid.no-results"),
        css_classes: ["app-grid-no-results-label"],
    })
    noResults.append(noResultsIcon)
    noResults.append(noResultsLabel)

    const monitorGeo = monitor.get_geometry()
    const innerWidth = Math.max(920, Math.min(Math.round(monitorGeo.width * 0.50), 950))
    const GRID_ROWS = 3
    const ROW_H    = 163
    const scrollHeight = GRID_ROWS * ROW_H + (GRID_ROWS - 1) * 8 + 16

    // The flowbox centres its tiles in the full width, so nothing lives at the right
    // edge for the bar to cover — no lane to reserve here.
    const { widget: scrollBox, scrolled: scroll } = NidaraScrolled({
        child: flowbox,
        reserveLane: false,
        cssClasses: ["app-grid-scroll"],
    })
    scroll.hexpand = true
    scroll.height_request = scrollHeight
    scrollBox.hexpand = true

    // Still needed by the keyboard navigation below, not by any fade.
    const adj = scroll.get_vadjustment()

    // No scroll-edge fade here. It used to be a separate DrawingArea overlaid on
    // the scroller, painting the chrome colour at overlayOpacity — which meant it
    // was not part of the panel and did not follow the panel's close animation, so
    // it visibly outlived it. The scrollbar already signals "there is more".
    const scrollOverlay = new Gtk.Overlay()
    scrollOverlay.set_child(scrollBox)

    const gridArea = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: false,
        hexpand: true,
        // ⚠️ The panel's vertical budget lives HERE, on the container, not on
        // whichever child happens to be showing. It used to live only on `scroll`,
        // so hiding the scroller for the no-results state left nothing holding the
        // height and the whole panel collapsed from ~738px to ~280px — a launcher
        // that changes size while you type, and (because the input region is stamped
        // from the panel's bounds) ~630px of dead screen that swallowed clicks
        // instead of dismissing. Both were the same missing line.
        //
        // `height_request` can only RAISE a minimum, never cap, so this cannot fight
        // the scroller's own request — the too-BIG direction is already capped there.
        // Stating it on the container is what makes it survive a third state being
        // added later without anyone remembering this.
        height_request: scrollHeight,
    })
    gridArea.append(scrollOverlay)
    // `noResults` already asks for `valign: CENTER` + `vexpand: true`; it just had no
    // space to centre in. With the budget above it lands in the middle of the grid
    // area instead of clinging to the top of a short panel.
    gridArea.append(noResults)

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: false,
        vexpand: false,
        width_request: innerWidth,
    })
    contentBox.append(wsStrip)
    contentBox.append(searchBox)
    contentBox.append(gridArea)

    const squirclePanel = SquircleContainer({
        child: contentBox,
        radius: RADIUS.xl,
        gloss: true,
        useShellOpacity: true,
        inset: 2.0,
        hexpand: false,
        vexpand: false,
    })
    // Shared overlay pop — same grow+fade as CC/NC/Prism. The docks call
    // setVisible() instead of toggling .visible directly so it animates.
    const panelPop = new ScaleRevealer(squirclePanel, { ...OVERLAY_POP, pivot: "center" })
    const setVisible = (open: boolean, onDone?: () => void) => panelPop.reveal(open, onDone)
    contentBox.margin_top    = 28
    contentBox.margin_start  = 32
    contentBox.margin_end    = 32
    contentBox.margin_bottom = 4
    panelPop.halign = Gtk.Align.CENTER
    panelPop.valign = Gtk.Align.CENTER

    // ── Widget state ───────────────────────────────────────────────────────
    const widgetCache = new Map<string, Gtk.Button>()
    const iconRefMap = new Map<string, { image: Gtk.Image, originalIconName: string }>()
    let cacheInitialized = false
    let currentQuery = ""
    let currentMatchIds: Set<string> | null = null
    const sortOrder = new Map<string, number>()

    flowbox.set_filter_func((child) => {
        if (!currentMatchIds) return true
        const appId: string = (child.get_child() as any)?._appId || ""
        return currentMatchIds.has(appId)
    })

    flowbox.set_sort_func((childA, childB) => {
        const idA: string = (childA.get_child() as any)?._appId || ""
        const idB: string = (childB.get_child() as any)?._appId || ""
        if (sortOrder.size > 0) {
            const rankA = sortOrder.has(idA) ? sortOrder.get(idA)! : 9999
            const rankB = sortOrder.has(idB) ? sortOrder.get(idB)! : 9999
            if (rankA !== rankB) return rankA - rankB
        }
        const nameA: string = (childA.get_child() as any)?._appName || ""
        const nameB: string = (childB.get_child() as any)?._appName || ""
        return nameA.localeCompare(nameB)
    })

    // ── App widget factory ─────────────────────────────────────────────────
    const createAppWidget = (app: AppData): Gtk.Button => {
        const id = normId(app.id)
        const name = app.name
        // The `Icon=` field verbatim, NOT app.icon (already canonicalized): this is
        // the key an icon override is filed under, and refreshIcons re-resolves from
        // it on every theme change.
        const iconName = app.rawIcon || "application-x-executable"

        const icon = new Gtk.Image({
            pixel_size: 72,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
        })
        const resolved = appService.getIconName(iconName)
        if (resolved && resolved.startsWith("/")) {
            icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(resolved))
        } else {
            // Unresolvable name → generic app icon from the active theme, never
            // GTK's broken-image placeholder (looks like an error, not a gap).
            icon.icon_name = resolved || "application-x-executable"
        }
        iconRefMap.set(id, { image: icon, originalIconName: iconName })

        const plate = new Gtk.Box({
            css_classes: ["app-grid-plate"],
            width_request: 96,
            height_request: 96,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        })
        plate.append(icon)

        const label = new Gtk.Label({
            label: name,
            css_classes: ["app-grid-label"],
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 13,
            wrap: true,
            // WORD (not WORD_CHAR): a single-word app name ("Files", "Firefox") must
            // never split mid-word. WORD_CHAR lets the wrapping label report a ~1-char
            // minimum width, so under width pressure (smaller screen / fallback font in
            // a fresh VM) the container squeezes it to a sliver and it wraps to fill both
            // lines. WORD floors the minimum at the widest word, so short names stay on
            // one line; only multi-word names wrap, and over-long single words ellipsize.
            wrap_mode: (Pango as any).WrapMode.WORD,
            lines: 2,
            ellipsize: (Pango as any).EllipsizeMode.END,
        })

        const item = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ["app-grid-item"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
        })
        item.append(plate)
        item.append(label)

        const button = new Gtk.Button({
            css_classes: ["app-grid-button"],
        })
        attachTooltip(button, name) // glass tooltip with the full app name (the visible label may truncate)
        button.set_child(item)
        ;(button as any)._appId = id
        ;(button as any)._appName = name.toLowerCase()

        // ── Context menu (pin/unpin) — nidara glass ─────────────────────────
        // A plain Gtk.Popover (NOT Gtk.PopoverMenu, whose native chrome can't be
        // themed to glass) whose body is the SAME Cairo glass bubble as the dock
        // menu and the tooltip (common/GlassBubble) plus the unified .nidara-menu
        // rows (renderMenuModel). It's its own surface, so it blurs on the dock's
        // OVERLAY layer (blur_popups). The pointer is painted by us, so we choose
        // the open direction ourselves (the item can sit anywhere in the grid) and
        // aim the arrow back at it — GTK's own flip would desync a fixed Cairo arrow.
        let menuPopover: Gtk.Popover | null = null
        let menuRows: Gtk.Box | null = null
        let menuDraw: Gtk.DrawingArea | null = null
        let menuSide: ArrowSide = "top"

        const ensureMenu = () => {
            if (menuPopover) return
            menuPopover = new Gtk.Popover({
                autohide: true,        // grabs focus; dismiss on outside click
                has_arrow: false,      // we paint our own pointer in Cairo
                css_classes: ["nidara-menu-popover"],
            })
            menuPopover.set_has_tooltip(false)

            const grid = new Gtk.Grid()
            menuDraw = new Gtk.DrawingArea({
                hexpand: true, vexpand: true,
                halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
            })
            menuDraw.set_draw_func((_da, cr, w, h) => paintGlassBubble(cr, w, h, menuSide, { radiusMax: RADIUS.lg, n: 3.2 }))
            grid.attach(menuDraw, 0, 0, 1, 1)

            menuRows = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["nidara-menu"] })
            grid.attach(menuRows, 0, 0, 1, 1)

            const themeId = Theme.connect("changed", () => { if (menuDraw?.get_mapped()) menuDraw.queue_draw() })
            menuPopover.connect("destroy", () => safeDisconnect(Theme, themeId))
            menuPopover.set_child(grid)
            menuPopover.set_parent(item)
            // Nothing to do on "closed": the popup evicted our focus grab when it
            // opened, and FocusGrab notices the popover in this window's widget tree,
            // SUSPENDS the lease and retakes it here by itself (common/FocusGrab.ts).
        }

        const layoutMenu = () => {
            if (!menuRows) return
            // Same halo and silhouette as every other menu of rows (system menu, CC
            // context menu, bar panels): lg squircle body, arrow spliced in. The row's
            // hover fill spans this box, so this margin is the fill's own halo.
            const PAD = rowInsetFor(RADIUS.lg)
            menuRows.margin_top    = BUF + PAD + (menuSide === "top"    ? ARROW_H : 0)
            menuRows.margin_bottom = BUF + PAD + (menuSide === "bottom" ? ARROW_H : 0)
            menuRows.margin_start  = BUF + PAD + (menuSide === "left"   ? ARROW_H : 0)
            menuRows.margin_end    = BUF + PAD + (menuSide === "right"  ? ARROW_H : 0)
        }

        const updateMenu = () => {
            const isPinned = pinnedState.list.some(p => normId(p) === normId(id))
            const menuModel = new Gio.Menu()
            const actionGroup = new Gio.SimpleActionGroup()
            const pinAction = new Gio.SimpleAction({ name: "pin" })
            pinAction.connect("activate", () => {
                if (isPinned) {
                    pinnedState.list = pinnedState.list.filter(p => normId(p) !== normId(id))
                } else {
                    pinnedState.list.push(normId(id))
                }
                savePinned()
            })
            actionGroup.add_action(pinAction)
            menuModel.append(isPinned ? t("settings.dock.dockitem.unpin") : t("app-grid.menu.pin"), "pin")

            if (menuRows) {
                let c = menuRows.get_first_child()
                while (c) { const next = c.get_next_sibling(); menuRows.remove(c); c = next }
                menuRows.append(renderMenuModel(menuModel, actionGroup, () => menuPopover?.popdown()))
            }
        }

        const rightClick = new Gtk.GestureClick({ button: 3 })
        rightClick.connect("released", () => {
            if (menuPopover?.visible) { menuPopover.popdown(); return }
            ensureMenu()
            // Open downward by default; flip up for items low in the launcher so the
            // menu stays on screen and the arrow still points back at the item.
            let pos = Gtk.PositionType.BOTTOM
            const root = item.get_root() as Gtk.Widget | null
            if (root) {
                const [ok, bounds] = (item as any).compute_bounds(root)
                if (ok && bounds && root.get_height() > 0 && (bounds.origin.y + bounds.size.height / 2) > root.get_height() * 0.65) {
                    pos = Gtk.PositionType.TOP
                }
            }
            menuPopover!.set_position(pos)
            menuSide = sideFor(pos)
            layoutMenu()
            menuDraw?.queue_draw()
            updateMenu()
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                menuPopover?.popup()
                return GLib.SOURCE_REMOVE
            })
        })
        item.add_controller(rightClick)

        // ── Launch ─────────────────────────────────────────────────────────
        button.connect("clicked", () => {
            onClose()
            if (id === "nidara-settings") {
                shellActions.openSettings?.()
                return
            }
            // Origin-aware command (gtk-launch / flatpak run) — see AppService.
            // getLaunchCommand. cd $HOME so the app doesn't inherit the shell
            // process's CWD (ui/shell).
            const cmd = appService.getLaunchCommand(id || app.exec)
            execAsync(["uwsm", "app", "--", "sh", "-c", `cd "$HOME" && exec ${cmd}`])
                // gtk-launch fails when the desktop id isn't in the XDG index, and
                // it does happen (this machine's ~/.cache/astal/apps-frequents.json
                // had counted 7 fallbacks for one editor). Falling back to the Exec
                // line still goes through `uwsm app`, so the app keeps its systemd
                // slice — the AstalApps fallback this replaces did NOT: AppInfo.launch
                // spawns as a child of the shell.
                .catch(() => {
                    console.warn(`[AppGrid] ${cmd} failed for ${id}; launching Exec= directly`)
                    appService.getResolvedApp(id)?.launch()
                })
        })

        return button
    }

    // ── Cache ──────────────────────────────────────────────────────────────
    const resetCache = () => {
        widgetCache.clear()
        iconRefMap.clear()
        cacheInitialized = false
        let child = flowbox.get_first_child()
        while (child) { const next = child.get_next_sibling(); flowbox.remove(child); child = next }
    }

    // Theme/icon changes: refresh icon images in-place, no widget recreation
    const refreshIcons = () => {
        for (const [, { image, originalIconName }] of iconRefMap) {
            const resolved = appService.getIconName(originalIconName)
            if (resolved && resolved.startsWith("/")) {
                image.gicon = Gio.FileIcon.new(Gio.File.new_for_path(resolved))
            } else {
                image.icon_name = resolved || "application-x-executable"
            }
        }
    }

    appService.connect(refreshIcons)
    // AppService already reloaded its registry before firing this — no second scan.
    appService.connectStructural(() => { resetCache(); initCache() })

    const initCache = () => {
        if (cacheInitialized) return
        appService.listApps().forEach(app => {
            const id = normId(app.id)
            if (id && !widgetCache.has(id)) {
                const widget = createAppWidget(app)
                widgetCache.set(id, widget)
                flowbox.append(widget)
            }
        })
        cacheInitialized = true
    }

    // ── Filter + sort ──────────────────────────────────────────────────────
    // `navIdx` and `getVisibleChildren` are declared HERE, above their users in
    // both this section and the keyboard section, because `filterApps` reads them
    // on every keystroke. They used to live with the arrow keys; leaving them
    // there works only as long as nothing calls `filterApps` before that line
    // runs, which is a temporal-dead-zone crash waiting for a reorder.

    /** -1 = nobody is arrowing. Only `focusAt`/`returnToSearch` move it. */
    let navIdx = -1

    const getVisibleChildren = (): Gtk.FlowBoxChild[] => {
        const result: Gtk.FlowBoxChild[] = []
        let c = flowbox.get_first_child()
        while (c) {
            if (c.visible) result.push(c as Gtk.FlowBoxChild)
            c = c.get_next_sibling()
        }
        return result
    }

    const updateNoResults = () => {
        const empty = !!currentMatchIds && currentMatchIds.size === 0
        noResults.set_visible(empty)
        scrollOverlay.set_visible(!empty)
    }

    /**
     * With a query typed, ring the top result so it is VISIBLE which app Enter
     * will open. `:selected` in `_app-grid.scss` paints the plate's accent ring;
     * the button FILL that also marks arrow navigation comes from `:focus`, which
     * this deliberately does not take — the ring alone reads as "this is the hit",
     * the ring plus fill as "you are standing here".
     *
     * **`navIdx` stays at -1 on purpose.** It is a hint, not a cursor. Were it a
     * cursor, the next character typed would hit `handleKey`'s
     * `if (navIdx >= 0) returnToSearch()` branch, which exists to leave the grid
     * when you start typing again — so every keystroke would fight the highlight
     * it had just placed. Arrow keys set `navIdx` and take over from there, which
     * is why this bails out while somebody is navigating.
     */
    const highlightTopResult = () => {
        if (navIdx >= 0) return
        const first = currentQuery ? getVisibleChildren()[0] : null
        if (first) flowbox.select_child(first)
        else flowbox.unselect_all()
    }

    const filterApps = (query = "") => {
        if (!cacheInitialized) initCache()
        currentQuery = query.trim().toLowerCase()

        if (!currentQuery) {
            currentMatchIds = null
            sortOrder.clear()
        } else {
            // The ranking is entirely AppService's (core/app-search): already
            // best-first and already total, so the grid just numbers it. The
            // name-prefix re-scoring that used to live here existed to repair
            // AstalApps' order — Prism ranks with the same function now, so the
            // two surfaces answer the same query the same way.
            currentMatchIds = new Set<string>()
            sortOrder.clear()
            appService.queryApps(currentQuery).forEach((app, i) => {
                const id = normId(app.id)
                currentMatchIds!.add(id)
                sortOrder.set(id, i)
            })
        }

        flowbox.invalidate_filter()
        flowbox.invalidate_sort()
        updateNoResults()
        if (currentQuery) clearWsNav()
        // Both invalidations apply synchronously, so the top result is already in
        // place by here — that is also why `focusAt(0)` works on the keystroke
        // right after typing.
        highlightTopResult()
    }

    searchEntry.connect("changed", () => filterApps(searchEntry.text))

    // ── Keyboard navigation ────────────────────────────────────────────────
    const returnToSearch = () => {
        navIdx = -1
        clearWsNav()
        flowbox.unselect_all()
        searchBox.add_css_class("search-active")
        searchEntry.grab_focus()
        // Leaving the grid is not leaving the QUERY: put the top-result ring back
        // (a no-op when the search box is empty). Callers that go on to edit the
        // buffer re-run this through `filterApps`; the ws-strip Backspace path
        // does not, and without this it would strand a query with no hit marked.
        highlightTopResult()
    }

    const focusAt = (idx: number) => {
        clearWsNav()
        const children = getVisibleChildren()
        if (!children.length) return
        navIdx = Math.max(0, Math.min(idx, children.length - 1))
        flowbox.select_child(children[navIdx])
        searchBox.remove_css_class("search-active")
        children[navIdx].grab_focus()
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const row    = Math.floor(navIdx / GRID_COLS)
            const rowTop = 8 + row * (ROW_H + 8)
            const rowBot = rowTop + ROW_H
            const cur    = adj.get_value()
            const page   = adj.get_page_size()
            const maxVal = Math.max(0, adj.get_upper() - page)
            const PAD    = 8
            if (rowTop - PAD < cur) {
                adj.set_value(Math.max(0, rowTop - PAD))
            } else if (rowBot + PAD > cur + page) {
                adj.set_value(Math.min(maxVal, rowBot + PAD - page))
            }
            return GLib.SOURCE_REMOVE
        })
    }

    flowbox.connect("child-activated", (_fb, child) => {
        const btn = child.get_child() as Gtk.Button
        btn?.emit("clicked")
    })

    filterApps()

    return {
        widget: panelPop,
        glassArea: (squirclePanel as any).glassArea ?? null,
        setVisible,

        onShow() {
            navIdx = -1
            wsNav = 0
            flowbox.unselect_all()
            searchEntry.get_buffer().set_text("", -1)
            searchEntry.set_position(-1)   // same reason as searchInsert: the buffer has no caret
            filterApps()
            searchBox.remove_css_class("search-active")
            focusWsSlot(hs.focusedWorkspaceId || 1)
        },

        handleKey(keyval: number): boolean {
            if (keyval === Gdk.KEY_Escape) {
                onClose(); return true
            }

            // ── Workspace strip navigation ──────────────────────────────
            if (wsNav > 0) {
                if (keyval === Gdk.KEY_Left) {
                    if (wsNav > 1) focusWsSlot(wsNav - 1)
                    return true
                }
                if (keyval === Gdk.KEY_Right) {
                    if (wsNav < 5) focusWsSlot(wsNav + 1)
                    return true
                }
                if (keyval === Gdk.KEY_Up) {
                    // top of the UI, do nothing
                    return true
                }
                if (keyval === Gdk.KEY_Down) {
                    clearWsNav()
                    focusAt(0)
                    return true
                }
                if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
                    switchWorkspace(wsNav)
                    return true
                }
                // Backspace / printable char → back to search
                if (keyval === Gdk.KEY_BackSpace) {
                    returnToSearch(); return true
                }
                if (keyval >= Gdk.KEY_space && keyval <= Gdk.KEY_asciitilde) {
                    returnToSearch()
                    searchInsert(String.fromCharCode(keyval))
                    return true
                }
                return false
            }

            // ── App grid / search navigation ────────────────────────────
            if (keyval === Gdk.KEY_Down) {
                focusAt(navIdx < 0 ? 0 : navIdx + GRID_COLS); return true
            }
            if (keyval === Gdk.KEY_Up) {
                if (navIdx < 0) {
                    focusWsSlot(hs.focusedWorkspaceId || 1)
                    return true
                }
                if (navIdx < GRID_COLS) { focusWsSlot(hs.focusedWorkspaceId || 1) }
                else { focusAt(navIdx - GRID_COLS) }
                return true
            }
            if (keyval === Gdk.KEY_Right) {
                if (navIdx < 0) return false
                focusAt(navIdx + 1); return true
            }
            if (keyval === Gdk.KEY_Left) {
                if (navIdx < 0) return false
                focusAt(navIdx - 1); return true
            }
            if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
                if (navIdx >= 0) {
                    const children = getVisibleChildren()
                    ;(children[navIdx]?.get_child() as Gtk.Button)?.emit("clicked")
                    return true
                }
                // No cursor, but a query: open the top hit — the one wearing the
                // ring `highlightTopResult` put there. Gated on `currentQuery`
                // because with the grid UNFILTERED "the first one" is whatever
                // sorts first alphabetically, and a stray Enter opening Add/Remove
                // Software is worse than an Enter that does nothing.
                if (currentQuery) {
                    const first = getVisibleChildren()[0]
                    if (first) {
                        ;(first.get_child() as Gtk.Button)?.emit("clicked")
                        return true
                    }
                }
            }
            if (keyval === Gdk.KEY_BackSpace) {
                if (navIdx >= 0) returnToSearch()
                searchBackspace()
                return true
            }
            if (keyval >= Gdk.KEY_space && keyval <= Gdk.KEY_asciitilde) {
                if (navIdx >= 0) returnToSearch()
                searchInsert(String.fromCharCode(keyval))
                return true
            }
            return false
        },

        setActive(active: boolean) {
            if (active) searchBox.add_css_class("search-active")
            else searchBox.remove_css_class("search-active")
        },
    }
}
