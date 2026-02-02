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
import { getMappedIcon } from "../core/IconMapper"

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
        name: "app-grid-window",
        css_classes: ["app-grid-window"],
    })

    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_monitor(win, monitor)
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    Gtk4LayerShell.set_namespace(win, "app-grid")
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)

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
        name: "app-grid-flowbox", // V114: Added ID
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.START,
        hexpand: true,
        max_children_per_line: 7,
        min_children_per_line: 4,
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 30,
        row_spacing: 40,
        css_classes: ["app-grid-flow"],
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
        width_request: 1200,
        height_request: 880,
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

    // INITIAL RENDER
    const renderApps = (query = "") => {
        let child = flowbox.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            flowbox.remove(child)
            child = next
        }

        const list = query.trim()
            ? appsService.fuzzy_query(query)
            : appsService.get_list().sort((a, b) => (a.name || "").localeCompare(b.name || ""))

        list.forEach(app => {
            const id = (app.get_id ? app.get_id() : (app as any).id || "").toLowerCase()
            const name = app.get_name ? app.get_name() : (app as any).name || ""

            const iconName = app.icon_name || "image-missing"
            const mapped = getMappedIcon(iconName, id, name)

            const icon = new Gtk.Image({
                pixel_size: 64,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                hexpand: true,
                vexpand: true,
            })

            const resolved = appService.getIconName(mapped)
            if (resolved && resolved.startsWith("/")) {
                icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(resolved))
            } else {
                icon.icon_name = resolved || mapped
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
                ellipsize: Pango.EllipsizeMode.END
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
            button.connect("clicked", () => {
                app.launch()
                win.visible = false
            })

            flowbox.append(button)
        })
    }

    searchEntry.connect("changed", () => {
        renderApps(searchEntry.text)
    })

    renderApps()

        // Global toggle mechanism
        ; (win as any).toggle = () => {
            win.visible = !win.visible
            if (win.visible) {
                searchEntry.text = ""
                searchEntry.grab_focus()
                renderApps()
            }
        }

    return win
}
