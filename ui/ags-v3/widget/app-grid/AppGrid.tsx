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
        halign: Gtk.Align.CENTER,
        width_request: 500,
    })
    searchBox.append(new Gtk.Image({ icon_name: Icons.search, pixel_size: 18, css_classes: ["app-grid-search-icon"] }))
    searchBox.append(searchEntry)

    // ── FlowBox ────────────────────────────────────────────────────────────
    const flowbox = new Gtk.FlowBox({
        name: "app-grid-flowbox",
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
        hexpand: true,
        max_children_per_line: 6,
        min_children_per_line: 3,
        selection_mode: Gtk.SelectionMode.SINGLE,
        column_spacing: 8,
        row_spacing: 16,
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
        icon_name: Icons.search,
        pixel_size: 48,
        css_classes: ["app-grid-no-results-icon"],
    })
    const noResultsLabel = new Gtk.Label({
        label: t("app-grid.no-results"),
        css_classes: ["app-grid-no-results-label"],
    })
    noResults.append(noResultsIcon)
    noResults.append(noResultsLabel)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        hexpand: true,
        css_classes: ["app-grid-scroll"],
    })
    scroll.set_child(flowbox)

    // ── Grid area (scroll + no-results) ───────────────────────────────────
    const gridArea = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true,
        hexpand: true,
    })
    gridArea.append(scroll)
    gridArea.append(noResults)

    // ── Main content column ────────────────────────────────────────────────
    const contentCol = new Gtk.Box({
        name: "app-grid-content",
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["app-grid-content"],
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        hexpand: true,
        vexpand: true,
    })
    contentCol.append(searchBox)
    contentCol.append(gridArea)

    // ── Root container (background + click-to-close) ───────────────────────
    // GestureClick with BUBBLE phase fires for clicks on empty areas not
    // consumed by children (buttons, etc.)
    const mainBox = new Gtk.Box({
        name: "app-grid-main-overlay",
        css_classes: ["app-grid-background"],
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    })
    mainBox.append(contentCol)

    const bgClick = new Gtk.GestureClick()
    bgClick.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
    bgClick.connect("released", (_gesture, _n, x, y) => {
        // Only close if click is outside the flowbox area
        // (buttons stop propagation so they won't trigger this)
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            win.visible = false
            return GLib.SOURCE_REMOVE
        })
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
                ;(globalThis as any).toggleSettings?.()
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
        scroll.set_visible(!empty)
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
            matches.forEach((a: any, i: number) => {
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
    const keyController = new Gtk.EventControllerKey()
    keyController.connect("key-pressed", (_c, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            win.visible = false
            return true
        }
        if (keyval === Gdk.KEY_Down && searchEntry.has_focus) {
            const first = flowbox.get_child_at_index(0)
            if (first) { flowbox.select_child(first); first.grab_focus() }
            return true
        }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const selected = flowbox.get_selected_children()
            if (selected?.length > 0) {
                const btn = selected[0].get_child() as Gtk.Button
                btn?.emit("clicked")
                return true
            }
        }
        return false
    })
    win.add_controller(keyController)

    flowbox.connect("child-activated", (_fb, child) => {
        const btn = child.get_child() as Gtk.Button
        btn?.emit("clicked")
    })

    filterApps()

    ;(win as any).toggle = () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const isVis = win.get_visible()
            win.set_visible(!isVis)
            if (!isVis) {
                win.present()
                searchEntry.text = ""
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    searchEntry.grab_focus()
                    return GLib.SOURCE_REMOVE
                })
                filterApps()
            }
            return GLib.SOURCE_REMOVE
        })
    }

    return win
}
