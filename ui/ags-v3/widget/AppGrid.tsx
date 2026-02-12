import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalHyprland from "gi://AstalHyprland"
import appService from "../core/AppService"
// V127: Native Gtk Resolution - No mapping needed

const appsService = new AstalApps.Apps()
const hyprland = AstalHyprland.get_default()

/**
 * WorkspaceStrip - Desktop indicator/switcher 💎
 */
function WorkspaceStrip() {
    const box = new Gtk.Box({
        name: "app-grid-workspaces", // V114: Added ID
        css_classes: ["app-grid-workspaces"],
        halign: Gtk.Align.CENTER,
        spacing: 12,
        margin_bottom: 30,
    })

    const syncWorkspaces = () => {
        let child = box.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            box.remove(child)
            child = next
        }

        const workspaces = hyprland.get_workspaces().sort((a, b) => a.id - b.id)
        workspaces.forEach(ws => {
            if (ws.id < 0) return

            const active = hyprland.focused_workspace.id === ws.id
            const btn = new Gtk.Button({
                label: ws.id.toString(),
                css_classes: ["workspace-item", active ? "active" : ""],
            })
            btn.connect("clicked", () => ws.focus())
            box.append(btn)
        })
    }

    hyprland.connect("notify::focused-workspace", syncWorkspaces)
    hyprland.connect("workspace-added", syncWorkspaces)
    hyprland.connect("workspace-removed", syncWorkspaces)

    syncWorkspaces()
    return box
}

/**
 * SystemActionStrip - Quick links 💎
 */
function SystemActionStrip(win: Gtk.Window) {
    const box = new Gtk.Box({
        name: "app-grid-system-actions", // V114: Added ID
        css_classes: ["app-grid-system-actions"],
        halign: Gtk.Align.CENTER,
        spacing: 60,
        margin_top: 40,
    })

    const actions = [
        { icon: "utilities-terminal", name: "Terminal", cmd: "kitty" },
        { icon: "emblem-system", name: "Ajustes", cmd: "gnome-control-center" },
        { icon: "system-reboot", name: "Reiniciar", cmd: "reboot" },
        { icon: "system-shutdown", name: "Apagar", cmd: "shutdown now" },
    ]

    actions.forEach(a => {
        const icon = new Gtk.Image({ icon_name: a.icon, pixel_size: 28 })
        const btn = new Gtk.Button({
            child: icon,
            tooltip_text: a.name,
            css_classes: ["system-action-btn"],
        })
        btn.connect("clicked", () => {
            execAsync(a.cmd).catch(print)
            win.visible = false
        })
        box.append(btn)
    })

    return box
}

/**
 * AppGrid - Fullscreen Launchpad for DistroIA 💎
 */
export default function AppGrid(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "crystal-app-launcher",
        css_classes: ["app-grid-window"],
    })

    // V135: Initialize LayerShell first
    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) { }

    if (layerInit) {
        Gtk4LayerShell.set_namespace(win, "launcher") // Use "launcher" to match existing Hyprland blur rules
        Gtk4LayerShell.set_monitor(win, monitor)
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
    }

    win.visible = false


    const searchEntry = new Gtk.Entry({
        name: "app-grid-search-entry",
        placeholder_text: "Buscar aplicaciones...",
        halign: Gtk.Align.CENTER,
        css_classes: ["app-grid-search"],
        width_request: 550,
        margin_bottom: 50,
    })

    const flowbox = new Gtk.FlowBox({
        name: "app-grid-flowbox",
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.START,
        hexpand: true,
        max_children_per_line: 7,
        min_children_per_line: 4,
        selection_mode: Gtk.SelectionMode.SINGLE, // V106: Enable keyboard navigation
        column_spacing: 30,
        row_spacing: 40,
        css_classes: ["app-grid-flow"],
        can_focus: true, // V106: Allow focus for keyboard nav
    })

    const scroll = new Gtk.ScrolledWindow({
        name: "app-grid-scrolled-window", // V114: Added ID
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        hexpand: true,
        css_classes: ["app-grid-scroll"]
    })
    scroll.set_child(flowbox)

    const contentBox = new Gtk.Box({
        name: "app-grid-content",
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["app-grid-content"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        width_request: 1000, // Slightly more compact
        height_request: 800,
    })

    contentBox.append(WorkspaceStrip())
    contentBox.append(searchEntry)
    contentBox.append(scroll)
    contentBox.append(SystemActionStrip(win))

    const overlayTrigger = new Gtk.Box({
        name: "app-grid-overlay",
        css_classes: ["app-grid-catcher"], // Clear any "main" background here
        hexpand: true,
        vexpand: true,
    })

    const click = new Gtk.GestureClick()
    click.connect("pressed", () => {
        win.visible = false
    })
    overlayTrigger.add_controller(click)

    const mainOverlay = new Gtk.Overlay({
        name: "app-grid-main-overlay"
    })
    mainOverlay.set_child(overlayTrigger)
    mainOverlay.add_overlay(contentBox)

    win.set_child(mainOverlay)

    // V106: OPTIMIZED APP GRID - Widget Cache + Visibility Filtering 🚀
    // Apps are created once and filtered via visibility instead of destroying/recreating
    const widgetCache = new Map<string, Gtk.Button>()
    let cachedApps: any[] = []
    let cacheInitialized = false

    // Create widget for a single app (called once per app, cached)
    const createAppWidget = (app: any): Gtk.Button => {
        // V125: Use entry (desktop file) as stable unique identifier
        const id = (app.entry || "").toLowerCase()
        const name = app.get_name ? app.get_name() : (app as any).name || ""

        const iconName = app.icon_name || "image-missing"
        // V127: Native Resolution (No mapping)

        const icon = new Gtk.Image({
            pixel_size: 64,
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
            css_classes: ["cd-squircle-plate"],
            width_request: 92,
            height_request: 92,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        })
        plate.append(icon)

        const label = new Gtk.Label({
            label: name,
            css_classes: ["app-grid-label"],
            halign: Gtk.Align.CENTER,
            max_width_chars: 14,
            ellipsize: (Pango as any).EllipsizeMode.END
        })

        const item = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ["app-grid-item"],
            halign: Gtk.Align.CENTER,
        })
        item.append(plate)
        item.append(label)

        const button = new Gtk.Button({
            css_classes: ["app-grid-button"],
        })
        button.set_child(item)
            // Store search metadata for filtering
            ; (button as any)._appId = id
            ; (button as any)._appName = name.toLowerCase()

        button.connect("clicked", () => {
            app.launch()
            win.visible = false
        })

        return button
    }

    // Initialize cache with all apps (called once)
    const initCache = () => {
        if (cacheInitialized) return

        cachedApps = appsService.get_list().sort((a, b) =>
            (a.name || "").localeCompare(b.name || "")
        )

        cachedApps.forEach(app => {
            const id = (app.entry || "").toLowerCase()
            if (id && !widgetCache.has(id)) {
                const widget = createAppWidget(app)
                widgetCache.set(id, widget)
                flowbox.append(widget)
            }
        })

        cacheInitialized = true
    }

    // Optimized filter: just toggle visibility instead of recreating
    const filterApps = (query = "") => {
        if (!cacheInitialized) {
            initCache()
        }

        const q = query.trim().toLowerCase()

        if (q === "") {
            // Show all apps
            widgetCache.forEach((widget) => {
                widget.set_visible(true)
            })
        } else {
            // Fuzzy match results from service
            const matches = appsService.fuzzy_query(query)
            const matchIds = new Set(
                matches.map(app => (app.entry || "").toLowerCase())
            )

            widgetCache.forEach((widget, id) => {
                const isMatch = matchIds.has(id) ||
                    (widget as any)._appName?.includes(q) ||
                    (widget as any)._appId?.includes(q)
                widget.set_visible(isMatch)
            })
        }

        // Select first visible child if flowbox has focus
        // Initialize LayerShell first - REMOVED REDUNDANT INIT

        const monitorWidth = monitor.get_geometry().width
        const monitorHeight = monitor.get_geometry().height
        win.set_default_size(monitorWidth, monitorHeight)

        const first = flowbox.get_first_child()
        if (first && first.get_visible()) {
            flowbox.select_child(first as any)
        }
    }


    searchEntry.connect("changed", () => {
        filterApps(searchEntry.text)
    })

    // V106: KEYBOARD NAVIGATION 🎹
    const keyController = new Gtk.EventControllerKey()
    keyController.connect("key-pressed", (controller, keyval, keycode, state) => {
        // Escape: Close the grid
        if (keyval === Gdk.KEY_Escape) {
            win.visible = false
            return true
        }
        // Down Arrow: Move focus from search to flowbox
        if (keyval === Gdk.KEY_Down && searchEntry.has_focus) {
            const first = flowbox.get_child_at_index(0)
            if (first) {
                flowbox.select_child(first)
                first.grab_focus()
            }
            return true
        }
        // Enter: Launch selected app (when flowbox has focus)
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const selected = flowbox.get_selected_children()
            if (selected && selected.length > 0) {
                const child = selected[0]
                const button = child.get_child() as Gtk.Button
                if (button) button.emit("clicked")
                return true
            }
        }
        return false
    })
    win.add_controller(keyController)

    // FlowBox: Activate on Enter when child is selected
    flowbox.connect("child-activated", (fb, child) => {
        const button = child.get_child() as Gtk.Button
        if (button) button.emit("clicked")
    })

    // Initialize on first show
    filterApps()

        // Global toggle mechanism
        ; (win as any).toggle = () => {
            console.log("[Grid] Internal toggle called")
            win.set_visible(!win.get_visible())
            if (win.get_visible()) {
                win.present()
                searchEntry.text = ""
                // V136: Focus fix with timeout
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    searchEntry.grab_focus()
                    return GLib.SOURCE_REMOVE
                })
                filterApps()
            }
        }

    return win
}
