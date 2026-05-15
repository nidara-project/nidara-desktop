import { Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
// @ts-ignore
import Pango from "gi://Pango"
import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import appService from "../../core/AppService"
import { pinnedState, savePinned } from "../dock/state"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import SquircleContainer from "../common/SquircleContainer"
import Theme from "../../core/ThemeManager"
import Cairo from "gi://cairo"
import shellActions from "../../core/ShellActions"

// Extract just the desktop basename, stripping path and .desktop extension
const normId = (s: string) => {
    const base = (s || "").split("/").pop() || s || ""
    return base.toLowerCase().replace(/\.desktop$/, "")
}

const appsService = new AstalApps.Apps()

export default function AppGrid(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "crystal-app-launcher",
        css_classes: ["app-grid-window"],
    })

    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) { }

    if (layerInit) {
        Gtk4LayerShell.set_namespace(win, "crystal-launcher")
        Gtk4LayerShell.set_monitor(win, monitor)
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        // Ignorar las zonas reservadas para cubrir el 100% de la pantalla (tapar dock y barra)
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
    }

    // @ts-ignore
    win.app_paintable = true
    win.visible = false

    // ── Search bar ─────────────────────────────────────────────────────────
    const searchEntry = new Gtk.Text({
        placeholder_text: t("app-grid.search.placeholder"),
        css_classes: ["app-grid-search-entry"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchBox = new Gtk.Box({
        css_classes: ["app-grid-search-box"],
        spacing: 10,
        hexpand: true,
    })
    searchBox.append(new Gtk.Image({ gicon: Icons.search, pixel_size: 18, css_classes: ["app-grid-search-icon", "cs-icon"] }))
    searchBox.append(searchEntry)

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
        css_classes: ["app-grid-no-results-icon", "cs-icon"],
    })
    const noResultsLabel = new Gtk.Label({
        label: t("app-grid.no-results"),
        css_classes: ["app-grid-no-results-label"],
    })
    noResults.append(noResultsIcon)
    noResults.append(noResultsLabel)

    const monitorGeo = monitor.get_geometry()
    // innerWidth must accommodate 6 columns: 6×142px child + 5×8px gap = 892px minimum
    const innerWidth = Math.max(920, Math.min(Math.round(monitorGeo.width * 0.50), 950))
    // Exact height for GRID_ROWS complete rows, derived from widget properties:
    //   button padding (12+12) + plate height (96) + item spacing (10) + label min-height (~33px) = 163px/row
    const GRID_ROWS = 3
    const ROW_H    = 163
    const scrollHeight = GRID_ROWS * ROW_H + (GRID_ROWS - 1) * 8 + 16  // rows + gaps + flowbox margins (8+8)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: false,
        hexpand: true,
        height_request: scrollHeight,
        css_classes: ["app-grid-scroll"],
    })
    scroll.set_child(flowbox)

    // ── Fade overlay — smooth top/bottom edges on scroll ──────────────────
    const adj = scroll.get_vadjustment()
    const FADE = 32

    const fadeDA = new Gtk.DrawingArea({ hexpand: true, vexpand: true, can_target: false })
    fadeDA.set_draw_func((_da: any, cr: any, w: number, h: number) => {
        const val   = adj.get_value()
        const upper = adj.get_upper()
        const page  = adj.get_page_size()
        const [r, g, b] = Theme.isDark ? [0, 0, 0] : [1, 1, 1]
        const a = Theme.shellOpacity

        cr.setOperator(2) // OVER

        if (val > 0.5) {
            const g1 = new Cairo.LinearGradient(0, 0, 0, FADE)
            g1.addColorStopRGBA(0, r, g, b, a)
            g1.addColorStopRGBA(1, r, g, b, 0)
            cr.setSource(g1)
            cr.rectangle(0, 0, w, FADE)
            cr.fill()
        }
        if (val < upper - page - 0.5) {
            const g2 = new Cairo.LinearGradient(0, h - FADE, 0, h)
            g2.addColorStopRGBA(0, r, g, b, 0)
            g2.addColorStopRGBA(1, r, g, b, a)
            cr.setSource(g2)
            cr.rectangle(0, h - FADE, w, FADE)
            cr.fill()
        }
    })
    adj.connect("value-changed", () => fadeDA.queue_draw())
    adj.connect("changed",       () => fadeDA.queue_draw())
    Theme.connect("changed",     () => fadeDA.queue_draw())

    const scrollOverlay = new Gtk.Overlay()
    scrollOverlay.set_child(scroll)
    scrollOverlay.add_overlay(fadeDA)

    // ── Grid area (scroll + no-results) ───────────────────────────────────
    const gridArea = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: false,
        hexpand: true,
    })
    gridArea.append(scrollOverlay)
    gridArea.append(noResults)

    // ── Content box (transparent — Cairo glass drawn by SquircleContainer) ──
    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: false,
        vexpand: false,
        width_request: innerWidth,
    })
    contentBox.append(searchBox)
    contentBox.append(gridArea)

    // ── Glass panel (Cairo squircle background, matching dock/CC aesthetic) ─
    const squirclePanel = SquircleContainer({
        child: contentBox,
        radius: 32,
        gloss: true,
        useShellOpacity: true,
        inset: 2.0,
        hexpand: false,
        vexpand: false,
    })
    // Asymmetric margins: breathing room at top/sides for the search bar,
    // tight at the bottom so the scroll grid clips at the squircle border.
    contentBox.margin_top    = 28
    contentBox.margin_start  = 32
    contentBox.margin_end    = 32
    contentBox.margin_bottom = 4
    squirclePanel.halign = Gtk.Align.CENTER

    // ── Root container (transparent full-screen, click-to-close) ─────────
    const spacerTop = new Gtk.Box({ vexpand: true })
    const spacerBottom = new Gtk.Box({ vexpand: true })

    const mainBox = new Gtk.Box({
        name: "app-grid-main-overlay",
        css_classes: ["app-grid-background"],
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    })
    mainBox.append(spacerTop)
    mainBox.append(squirclePanel)
    mainBox.append(spacerBottom)

    const bgClick = new Gtk.GestureClick()
    bgClick.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
    bgClick.connect("released", (_gesture, _n, x, y) => {
        const a = squirclePanel.get_allocation()
        if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) return
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { win.visible = false; return GLib.SOURCE_REMOVE })
    })
    mainBox.add_controller(bgClick)

    win.set_child(mainBox)

    // ── Widget state ───────────────────────────────────────────────────────
    const widgetCache = new Map<string, Gtk.Button>()
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
    const createAppWidget = (app: any): Gtk.Button => {
        const id = normId(app.entry || "")
        const name = app.get_name ? app.get_name() : (app as any).name || ""
        const iconName = app.icon_name || "image-missing"

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
            icon.icon_name = resolved || iconName
        }

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
            wrap_mode: (Pango as any).WrapMode.WORD_CHAR,
            lines: 2,
            ellipsize: (Pango as any).EllipsizeMode.END,
        })

        const item = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            css_classes: ["app-grid-item"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
        })
        item.append(plate)
        item.append(label)

        const button = new Gtk.Button({
            css_classes: ["app-grid-button"],
            tooltip_text: name,
        })
        button.set_child(item)
        ;(button as any)._appId = id
        ;(button as any)._appName = name.toLowerCase()

        // ── Context menu (pin/unpin) ───────────────────────────────────────
        let contextPopover: Gtk.Popover | null = null

        const buildContextMenu = () => {
            if (contextPopover?.visible) return
            contextPopover?.unparent()
            contextPopover = null

            const isPinned = pinnedState.list.some(p => normId(p) === normId(id))
            const actionGroup = new Gio.SimpleActionGroup()
            const menuModel = new Gio.Menu()

            const pinAction = new Gio.SimpleAction({ name: "pin" })
            pinAction.connect("activate", () => {
                if (isPinned) {
                    pinnedState.list = pinnedState.list.filter(p => normId(p) !== normId(id))
                } else {
                    pinnedState.list.push(normId(id))
                }
                savePinned()
                contextPopover?.popdown()
            })
            actionGroup.add_action(pinAction)
            menuModel.append(
                isPinned ? t("settings.dock.dockitem.label.desanclar-del-dock") : t("app-grid.menu.pin"),
                "context.pin"
            )

            item.insert_action_group("context", actionGroup)
            contextPopover = Gtk.PopoverMenu.new_from_model(menuModel) as unknown as Gtk.Popover
            contextPopover.set_parent(item)
        }

        const rightClick = new Gtk.GestureClick({ button: 3 })
        rightClick.connect("released", () => {
            buildContextMenu()
            if (layerInit) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                contextPopover?.popup()
                contextPopover?.connect("closed", () => {
                    if (layerInit) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
                })
                return GLib.SOURCE_REMOVE
            })
        })
        item.add_controller(rightClick)

        // ── Launch ─────────────────────────────────────────────────────────
        button.connect("clicked", () => {
            win.visible = false
            if (id === "crystal-shell-settings") {
                shellActions.toggleSettings?.()
                return
            }
            try {
                const realInfo = appService.getAppInfo(id || app.executable)
                const rawCommand = realInfo?.get_commandline() || app.executable || ""
                const command = rawCommand.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
                if (!command) { app.launch(); return }
                execAsync(["uwsm", "app", "--", "sh", "-c", command]).catch(() => app.launch())
            } catch (e) {
                app.launch()
            }
        })

        return button
    }

    // ── Cache init ─────────────────────────────────────────────────────────
    const resetCache = () => {
        widgetCache.clear()
        cacheInitialized = false
        let child = flowbox.get_first_child()
        while (child) { const next = child.get_next_sibling(); flowbox.remove(child); child = next }
    }

    // Rebuild icons when AppService reloads (e.g. after an icon override is saved)
    appService.connect(() => { resetCache(); initCache() })

    const initCache = () => {
        if (cacheInitialized) return
        const apps = appsService.get_list().sort((a, b) =>
            (a.name || "").localeCompare(b.name || "")
        )
        apps.forEach(app => {
            const id = normId(app.entry || "")
            if (id && !widgetCache.has(id)) {
                const widget = createAppWidget(app)
                widgetCache.set(id, widget)
                flowbox.append(widget)
            }
        })
        cacheInitialized = true
    }

    // ── Filter + sort ──────────────────────────────────────────────────────
    const updateNoResults = () => {
        const empty = !!currentMatchIds && currentMatchIds.size === 0
        noResults.set_visible(empty)
        scrollOverlay.set_visible(!empty)
    }

    const filterApps = (query = "") => {
        if (!cacheInitialized) initCache()
        currentQuery = query.trim().toLowerCase()

        if (!currentQuery) {
            currentMatchIds = null
            sortOrder.clear()
        } else {
            const matches = appsService.fuzzy_query(query)
            currentMatchIds = new Set<string>()
            sortOrder.clear()
            // Re-rank: prefix match > word-start match > generic fuzzy.
            // fuzzy_query alone doesn't prioritize prefix matches for short queries.
            const q = currentQuery
            const scored = (matches as any[]).map((a, fuzzyRank: number) => {
                const name = (a.name || "").toLowerCase()
                let score = 2
                if (name.startsWith(q)) score = 0
                else if (name.split(/\s+/).some((w: string) => w.startsWith(q))) score = 1
                return { a, fuzzyRank, score }
            })
            scored.sort((x, y) => x.score !== y.score ? x.score - y.score : x.fuzzyRank - y.fuzzyRank)
            scored.forEach(({ a }, i) => {
                const id = normId(a.entry || "")
                currentMatchIds!.add(id)
                sortOrder.set(id, i)
            })
        }

        flowbox.invalidate_filter()
        flowbox.invalidate_sort()
        updateNoResults()

        if (!noResults.visible) {
            const first = flowbox.get_first_child()
            if (first) flowbox.select_child(first as any)
        }
    }

    searchEntry.connect("changed", () => filterApps(searchEntry.text))

    // ── Keyboard navigation ────────────────────────────────────────────────
    // FlowBox's internal cursor (used for arrow-key nav) is a private field
    // with no public reset API — it persists between opens regardless of
    // unselect_all / select_child / grab_focus calls. We bypass it entirely
    // by tracking our own navIdx and handling all four arrow keys in CAPTURE.
    let navIdx = -1  // -1 = search has focus, ≥0 = index into visible children

    const getVisibleChildren = (): Gtk.FlowBoxChild[] => {
        const result: Gtk.FlowBoxChild[] = []
        let c = flowbox.get_first_child()
        while (c) {
            if (c.visible) result.push(c as Gtk.FlowBoxChild)
            c = c.get_next_sibling()
        }
        return result
    }

    const focusAt = (idx: number) => {
        const children = getVisibleChildren()
        if (!children.length) return
        navIdx = Math.max(0, Math.min(idx, children.length - 1))
        children[navIdx].grab_focus()
        // GTK auto-scroll puts the item flush against the edge. We override it
        // by computing the target scroll position manually with breathing room.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const row    = Math.floor(navIdx / GRID_COLS)
            const rowTop = 8 + row * (ROW_H + 8)   // flowbox margin_top + row offset
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

    const keyController = new Gtk.EventControllerKey()
    keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    keyController.connect("key-pressed", (_c, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            win.visible = false
            return true
        }
        if (keyval === Gdk.KEY_Tab) {
            if (navIdx < 0) focusAt(0)
            return true
        }
        if (keyval === Gdk.KEY_ISO_Left_Tab) {  // Shift+Tab
            if (navIdx >= 0) { navIdx = -1; searchEntry.grab_focus() }
            return true
        }
        if (keyval === Gdk.KEY_Down) {
            focusAt(navIdx < 0 ? 0 : navIdx + GRID_COLS)
            return true
        }
        if (keyval === Gdk.KEY_Up) {
            if (navIdx < 0) return false
            if (navIdx < GRID_COLS) { navIdx = -1; searchEntry.grab_focus() }
            else { focusAt(navIdx - GRID_COLS) }
            return true
        }
        if (keyval === Gdk.KEY_Right) {
            if (navIdx < 0) return false
            focusAt(navIdx + 1)
            return true
        }
        if (keyval === Gdk.KEY_Left) {
            if (navIdx < 0) return false
            focusAt(navIdx - 1)
            return true
        }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (navIdx >= 0) {
                const children = getVisibleChildren()
                ;(children[navIdx]?.get_child() as Gtk.Button)?.emit("clicked")
                return true
            }
        }
        if (navIdx >= 0 && keyval >= 32 && keyval <= 126) {
            navIdx = -1
            searchEntry.grab_focus()
            return false
        }
        return false
    })
    win.add_controller(keyController)

    flowbox.connect("child-activated", (_fb, child) => {
        const btn = child.get_child() as Gtk.Button
        btn?.emit("clicked")
    })

    filterApps()

    win.connect("map", () => {
        if (layerInit) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
        navIdx = -1
        searchEntry.grab_focus()
    })

    ;(win as any).toggle = () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const isVis = win.get_visible()
            if (!isVis) {
                navIdx = -1
                searchEntry.text = ""
                filterApps()
            }
            win.set_visible(!isVis)
            return GLib.SOURCE_REMOVE
        })
    }

    return win
}
