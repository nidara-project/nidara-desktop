import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import appService, { AppData } from "../../core/AppService"
import SquircleContainer from "../common/SquircleContainer"

/**
 * ResultRow - A single search result entry 💎
 */
function ResultRow(appData: AppData) {
    const box = new Gtk.Box({
        css_classes: ["prism-result-content"],
        spacing: 12,
        margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8
    })

    const icon = new Gtk.Image({
        pixel_size: 32,
        css_classes: ["prism-result-icon"]
    })

    const resolved = appService.getIconName(appData.icon)
    if (resolved && (resolved.startsWith("/") || resolved.startsWith("file://"))) {
        icon.file = resolved.replace("file://", "")
    } else {
        icon.icon_name = resolved || "application-x-executable"
    }

    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    labels.append(new Gtk.Label({
        label: appData.name,
        css_classes: ["prism-result-title"],
        halign: Gtk.Align.START,
        xalign: 0
    }))

    if (appData.id) {
        labels.append(new Gtk.Label({
            label: appData.id,
            css_classes: ["prism-result-description"],
            halign: Gtk.Align.START,
            xalign: 0
        }))
    }

    box.append(icon)
    box.append(labels)

    const row = new Gtk.ListBoxRow({
        child: box,
        css_classes: ["prism-result-row"]
    })
        ; (row as any).appData = appData

    return row
}

/**
 * Prism - macOS Tahoe style search interface 💎
 */
export default function Prism(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "crystal-prism",
        css_classes: ["prism-window-root"],
        application: app,
        visible: false
    })

    win.set_default_size(650, 400)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "prism")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)

        // Exact Center 🎯
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, false)
    } catch (e) { }

    const entry = new Gtk.Entry({
        placeholder_text: "Search apps, files, or settings...",
        css_classes: ["prism-search-entry"],
        hexpand: true,
        valign: Gtk.Align.CENTER
    })

    const resultsList = new Gtk.ListBox({
        css_classes: ["prism-results-list"],
        selection_mode: Gtk.SelectionMode.SINGLE,
        activate_on_single_click: true
    })

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        css_classes: ["prism-box"],
        width_request: 650
    })

    const searchContainer = new Gtk.Box({
        css_classes: ["prism-search-box"],
        spacing: 12
    })
    searchContainer.append(new Gtk.Image({ icon_name: "system-search-symbolic", pixel_size: 20 }))
    searchContainer.append(entry)

    contentBox.append(searchContainer)
    contentBox.append(resultsList)

    const prismWrapper = SquircleContainer({
        child: contentBox,
        radius: 32,
        n: 4.5,
        css_classes: ["prism-wrapper"],
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.15 }
    })

    win.set_child(prismWrapper)

    const launchResult = (row: any) => {
        const data = (row as any).appData as AppData
        if (data) {
            console.log(`[Prism] Launching: ${data.name}`)
            const appInfo = appService.getAppInfo(data.id)
            let cmd = appInfo?.get_commandline() || data.exec
            if (cmd) {
                cmd = cmd.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
                execAsync(["hyprctl", "dispatch", "exec", cmd]).catch(console.error)
            }
        }
        win.visible = false
    }

    resultsList.connect("row-activated", (_, row) => {
        if (row) launchResult(row)
    })

    entry.connect("changed", () => {
        const query = entry.text.trim()

        // Clear old results
        let child = resultsList.get_first_child()
        while (child) {
            resultsList.remove(child)
            child = resultsList.get_first_child()
        }

        if (query.length > 0) {
            resultsList.visible = true
            const results = appService.search(query)
            results.forEach(res => {
                resultsList.append(ResultRow(res))
            })

            // Select first by default
            const first = resultsList.get_row_at_index(0)
            if (first) resultsList.select_row(first)
        } else {
            resultsList.visible = false
        }
    })

    // Keyboard Controller 🎹
    const key = new Gtk.EventControllerKey()
    key.connect("key-pressed", (_, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            win.visible = false
            return true
        }

        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const selected = resultsList.get_selected_row()
            if (selected) {
                launchResult(selected)
                return true
            }
        }

        if (keyval === Gdk.KEY_Up) {
            const selected = resultsList.get_selected_row()
            if (selected) {
                const idx = selected.get_index()
                const prev = resultsList.get_row_at_index(idx - 1)
                if (prev) resultsList.select_row(prev)
                return true
            }
        }

        if (keyval === Gdk.KEY_Down) {
            const selected = resultsList.get_selected_row()
            if (selected) {
                const idx = selected.get_index()
                const next = resultsList.get_row_at_index(idx + 1)
                if (next) resultsList.select_row(next)
                return true
            }
        }

        return false
    })
    win.add_controller(key)

    // Global focus handling
    const click = new Gtk.GestureClick()
    click.connect("pressed", () => {
        win.visible = false
    })
        // Note: We don't add this to the whole window because it targets children.
        // Instead, we can use an overlay if we want to catch "outside" clicks.
        // For now, Escape and Enter are the primary ways.

        ; (win as any).toggle = () => {
            const isVis = win.visible
            console.log(`[Prism] Toggle: currently ${isVis ? 'visible' : 'hidden'}`)
            win.set_visible(!isVis)
            if (!isVis) {
                win.present()
                console.log("[Prism] Presenting window and focusing entry")
                entry.text = ""
                resultsList.visible = false
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    entry.grab_focus()
                    return GLib.SOURCE_REMOVE
                })
            }
        }

    return win
}
