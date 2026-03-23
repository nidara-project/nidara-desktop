import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import appService, { AppData } from "../../core/AppService"
import status from "../../core/Status"
import SquircleContainer from "../common/SquircleContainer"

function ResultRow(appData: AppData) {
    const box = new Gtk.Box({ css_classes: ["prism-result-content"], spacing: 12, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })
    const icon = new Gtk.Image({ pixel_size: 32, css_classes: ["prism-result-icon"] })
    const resolved = appService.getIconName(appData.icon)
    if (resolved && (resolved.startsWith("/") || resolved.startsWith("file://"))) icon.file = resolved.replace("file://", "")
    else icon.icon_name = resolved || "application-x-executable"

    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    labels.append(new Gtk.Label({ label: appData.name, css_classes: ["prism-result-title"], halign: Gtk.Align.START, xalign: 0 }))
    if (appData.id) labels.append(new Gtk.Label({ label: appData.id, css_classes: ["prism-result-description"], halign: Gtk.Align.START, xalign: 0 }))
    box.append(icon); box.append(labels)
    const row = new Gtk.ListBoxRow({ child: box, css_classes: ["prism-result-row"] }); (row as any).appData = appData
    return row
}

export default function Prism() {
    const entry = new Gtk.Entry({ placeholder_text: "Search apps, files, or settings...", css_classes: ["prism-search-entry"], hexpand: true, valign: Gtk.Align.CENTER })
    const resultsList = new Gtk.ListBox({ css_classes: ["prism-results-list"], selection_mode: Gtk.SelectionMode.SINGLE, activate_on_single_click: true })
    const contentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["prism-box"], width_request: 650 })
    const searchContainer = new Gtk.Box({ css_classes: ["prism-search-box"], spacing: 12 })
    searchContainer.append(new Gtk.Image({ icon_name: "system-search-symbolic", pixel_size: 20 })); searchContainer.append(entry)
    contentBox.append(searchContainer); contentBox.append(resultsList)

    const prismWrapper = SquircleContainer({ child: contentBox, radius: 32, n: 4.5, css_classes: ["prism-wrapper"], alpha: 0.15, gloss: true, borderColor: { r: 1, g: 1, b: 1, a: 0.15 } })

    const launchResult = (row: any) => {
        const data = (row as any).appData as AppData
        if (data) {
            const appInfo = appService.getAppInfo(data.id)
            let cmd = appInfo?.get_commandline() || data.exec
            if (cmd) {
                cmd = cmd.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
                execAsync(["hyprctl", "dispatch", "exec", cmd]).catch(console.error)
            }
        }
    }

    resultsList.connect("row-activated", (_, row) => { if (row) { launchResult(row); status.prism_open = false } })
    entry.connect("changed", () => {
        const query = entry.text.trim()
        let child = resultsList.get_first_child()
        while (child) { resultsList.remove(child); child = resultsList.get_first_child() }
        if (query.length > 0) {
            resultsList.visible = true
            appService.search(query).forEach(res => resultsList.append(ResultRow(res)))
            const first = resultsList.get_row_at_index(0); if (first) resultsList.select_row(first)
        } else resultsList.visible = false
    })

    const key = new Gtk.EventControllerKey()
    key.connect("key-pressed", (_, keyval) => {
        if (keyval === Gdk.KEY_Escape) { status.prism_open = false; return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) { const s = resultsList.get_selected_row(); if (s) { launchResult(s); status.prism_open = false; return true } }
        return false
    }); prismWrapper.add_controller(key)

    const sync = () => {
        prismWrapper.set_visible(status.prism_open)
        if (status.prism_open) entry.grab_focus()
    }
    status.connect("notify::prism-open", sync); sync()

    return prismWrapper
}
