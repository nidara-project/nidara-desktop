import { Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
// @ts-ignore
import Pango from "gi://Pango"
import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import hs from "../../core/HyprlandState"
import appService from "../../core/AppService"
import { pinnedState, savePinned } from "../dock/state"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { makeFadeToggle } from "../common/fade"
import SquircleContainer from "../common/SquircleContainer"
import Theme from "../../core/ThemeManager"
import Cairo from "gi://cairo"
import shellActions from "../../core/ShellActions"
import { createSchematicMap } from "../common/WorkspaceSchematic"

// Extract just the desktop basename, stripping path and .desktop extension
const normId = (s: string) => {
    const base = (s || "").split("/").pop() || s || ""
    return base.toLowerCase().replace(/\.desktop$/, "")
}

const appsService = new AstalApps.Apps()

export interface AppGridPanelHandle {
    widget: Gtk.Widget
    onShow: () => void
    handleKey: (keyval: number) => boolean
    setKeyboardModeCallback: (onExclusive: () => void, onDemand: () => void) => void
    setActive: (active: boolean) => void
    setVisible: (open: boolean) => void
}

export default function AppGridPanel(monitor: Gdk.Monitor, onClose: () => void): AppGridPanelHandle {
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
            hs.focusWorkspace(i)
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
    wsStrip.connect("unrealize", () => hs.disconnect(stripChangedId))
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
        css_classes: ["app-grid-no-results-icon", "cs-icon"],
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

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: false,
        hexpand: true,
        height_request: scrollHeight,
        css_classes: ["app-grid-scroll"],
    })
    scroll.set_child(flowbox)

    // ── Fade overlay ───────────────────────────────────────────────────────
    const adj = scroll.get_vadjustment()
    const FADE = 32
    const fadeDA = new Gtk.DrawingArea({ hexpand: true, vexpand: true, can_target: false })
    fadeDA.set_draw_func((_da: any, cr: any, w: number, h: number) => {
        if (w <= 0 || h <= 0) return
        const val   = adj.get_value()
        const upper = adj.get_upper()
        const page  = adj.get_page_size()
        const [r, g, b] = Theme.isDark ? [0, 0, 0] : [1, 1, 1]
        const a = Theme.shellOpacity
        cr.setOperator(2)
        if (val > 0.5) {
            const g1 = new Cairo.LinearGradient(0, 0, 0, FADE)
            g1.addColorStopRGBA(0, r, g, b, a)
            g1.addColorStopRGBA(1, r, g, b, 0)
            cr.setSource(g1); cr.rectangle(0, 0, w, FADE); cr.fill()
        }
        if (val < upper - page - 0.5) {
            const g2 = new Cairo.LinearGradient(0, h - FADE, 0, h)
            g2.addColorStopRGBA(0, r, g, b, 0)
            g2.addColorStopRGBA(1, r, g, b, a)
            cr.setSource(g2); cr.rectangle(0, h - FADE, w, FADE); cr.fill()
        }
    })
    adj.connect("value-changed", () => fadeDA.queue_draw())
    adj.connect("changed",       () => fadeDA.queue_draw())
    Theme.connect("changed",     () => { if (fadeDA.get_mapped()) fadeDA.queue_draw() })

    const scrollOverlay = new Gtk.Overlay()
    scrollOverlay.set_child(scroll)
    scrollOverlay.add_overlay(fadeDA)

    const gridArea = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: false,
        hexpand: true,
    })
    gridArea.append(scrollOverlay)
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
        radius: 32,
        gloss: true,
        useShellOpacity: true,
        inset: 2.0,
        hexpand: false,
        vexpand: false,
        css_classes: ["overlay-fade"],
    })
    // Shared overlay fade — same crossfade as CC/NC/Prism. The docks call
    // setVisible() instead of toggling .visible directly so it fades.
    const setVisible = makeFadeToggle(squirclePanel)
    contentBox.margin_top    = 28
    contentBox.margin_start  = 32
    contentBox.margin_end    = 32
    contentBox.margin_bottom = 4
    squirclePanel.halign = Gtk.Align.CENTER
    squirclePanel.valign = Gtk.Align.CENTER

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

    // Keyboard mode callbacks — wired by dock after construction
    let _cbExclusive: (() => void) | null = null
    let _cbDemand:    (() => void) | null = null

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
                isPinned ? t("settings.dock.dockitem.unpin") : t("app-grid.menu.pin"),
                "context.pin"
            )

            item.insert_action_group("context", actionGroup)
            contextPopover = Gtk.PopoverMenu.new_from_model(menuModel) as unknown as Gtk.Popover
            contextPopover.set_parent(item)
        }

        const rightClick = new Gtk.GestureClick({ button: 3 })
        rightClick.connect("released", () => {
            buildContextMenu()
            _cbDemand?.()
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                contextPopover?.popup()
                contextPopover?.connect("closed", () => { _cbExclusive?.() })
                return GLib.SOURCE_REMOVE
            })
        })
        item.add_controller(rightClick)

        // ── Launch ─────────────────────────────────────────────────────────
        button.connect("clicked", () => {
            onClose()
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
                image.icon_name = resolved || originalIconName
            }
        }
    }

    appService.connect(refreshIcons)
    appService.connectStructural(() => { appsService.reload(); resetCache(); initCache() })

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
        if (currentQuery) clearWsNav()
    }

    searchEntry.connect("changed", () => filterApps(searchEntry.text))

    // ── Keyboard navigation ────────────────────────────────────────────────
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

    const returnToSearch = () => {
        navIdx = -1
        clearWsNav()
        flowbox.unselect_all()
        searchBox.add_css_class("search-active")
        searchEntry.grab_focus()
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
        widget: squirclePanel,
        setVisible,

        onShow() {
            navIdx = -1
            wsNav = 0
            flowbox.unselect_all()
            searchEntry.get_buffer().set_text("", -1)
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
                    hs.focusWorkspace(wsNav)
                    return true
                }
                // Backspace / printable char → back to search
                if (keyval === Gdk.KEY_BackSpace) {
                    returnToSearch(); return true
                }
                if (keyval >= Gdk.KEY_space && keyval <= Gdk.KEY_asciitilde) {
                    returnToSearch()
                    const buf = searchEntry.get_buffer()
                    buf.insert_text(buf.get_length(), String.fromCharCode(keyval), 1)
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
            }
            if (keyval === Gdk.KEY_BackSpace) {
                if (navIdx >= 0) returnToSearch()
                const buf = searchEntry.get_buffer()
                const len = buf.get_length()
                if (len > 0) buf.delete_text(len - 1, 1)
                return true
            }
            if (keyval >= Gdk.KEY_space && keyval <= Gdk.KEY_asciitilde) {
                if (navIdx >= 0) returnToSearch()
                const buf = searchEntry.get_buffer()
                buf.insert_text(buf.get_length(), String.fromCharCode(keyval), 1)
                return true
            }
            return false
        },

        setKeyboardModeCallback(onExclusive: () => void, onDemand: () => void) {
            _cbExclusive = onExclusive
            _cbDemand    = onDemand
        },

        setActive(active: boolean) {
            if (active) searchBox.add_css_class("search-active")
            else searchBox.remove_css_class("search-active")
        },
    }
}
