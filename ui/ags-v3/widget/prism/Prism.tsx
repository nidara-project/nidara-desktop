import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import appService, { AppData } from "../../core/AppService"
import status from "../../core/Status"
import SquircleContainer from "../common/SquircleContainer"
import { t } from "../../core/i18n"

const MAX_FILE_RESULTS = 6

function AppResultRow(appData: AppData): Gtk.ListBoxRow {
    const box = new Gtk.Box({ css_classes: ["prism-result-content"], spacing: 12, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })
    const icon = new Gtk.Image({ pixel_size: 32, css_classes: ["prism-result-icon"] })
    const resolved = appService.getIconName(appData.icon)
    if (resolved && (resolved.startsWith("/") || resolved.startsWith("file://"))) icon.file = resolved.replace("file://", "")
    else icon.icon_name = resolved || "application-x-executable"

    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    labels.append(new Gtk.Label({ label: appData.name, css_classes: ["prism-result-title"], halign: Gtk.Align.START, xalign: 0 }))
    if (appData.id) labels.append(new Gtk.Label({ label: appData.id, css_classes: ["prism-result-description"], halign: Gtk.Align.START, xalign: 0 }))
    box.append(icon); box.append(labels)

    const row = new Gtk.ListBoxRow({ child: box, css_classes: ["prism-result-row"] })
    ;(row as any).appData = appData
    return row
}

function FileResultRow(uri: string, displayName: string, mimeType: string): Gtk.ListBoxRow {
    const box = new Gtk.Box({ css_classes: ["prism-result-content"], spacing: 12, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })

    const icon = new Gtk.Image({ pixel_size: 32, css_classes: ["prism-result-icon"] })
    try {
        const gicon = Gio.content_type_get_icon(mimeType)
        if (gicon) icon.gicon = gicon
        else icon.icon_name = "text-x-generic"
    } catch { icon.icon_name = "text-x-generic" }

    const path = (() => {
        try { return Gio.File.new_for_uri(uri).get_path() || uri } catch { return uri }
    })()
    const shortPath = path.replace(GLib.get_home_dir(), "~")

    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    labels.append(new Gtk.Label({ label: displayName, css_classes: ["prism-result-title"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 40 }))
    labels.append(new Gtk.Label({ label: shortPath, css_classes: ["prism-result-description"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 50 }))
    box.append(icon); box.append(labels)

    const row = new Gtk.ListBoxRow({ child: box, css_classes: ["prism-result-row"] })
    ;(row as any).fileUri = uri
    return row
}

function SeparatorRow(label: string): Gtk.ListBoxRow {
    const box = new Gtk.Box({ margin_start: 14, margin_top: 4, margin_bottom: 2 })
    box.append(new Gtk.Label({ label, css_classes: ["prism-section-label"], halign: Gtk.Align.START }))
    const row = new Gtk.ListBoxRow({ child: box, css_classes: ["prism-section-row"], selectable: false, activatable: false })
    return row
}

export default function Prism() {
    const entry = new Gtk.Entry({
        placeholder_text: t("prism.placeholder"),
        css_classes: ["prism-search-entry"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const resultsList = new Gtk.ListBox({ css_classes: ["prism-results-list"], selection_mode: Gtk.SelectionMode.SINGLE, activate_on_single_click: true })
    const revealer = new (Gtk as any).Revealer({
        transition_type: (Gtk as any).RevealerTransitionType.SLIDE_DOWN,
        transition_duration: 180,
        reveal_child: false,
        child: resultsList,
    })
    const contentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["prism-box"], width_request: 650, halign: Gtk.Align.CENTER })
    const searchContainer = new Gtk.Box({ css_classes: ["prism-search-box"], spacing: 12 })
    searchContainer.append(new Gtk.Image({ icon_name: "system-search-symbolic", pixel_size: 20 }))
    searchContainer.append(entry)
    contentBox.append(searchContainer)
    contentBox.append(revealer)

    const prismWrapper = SquircleContainer({ child: contentBox, radius: 32, n: 4.5, css_classes: ["prism-wrapper"], alpha: 0.15, gloss: true, borderColor: { r: 1, g: 1, b: 1, a: 0.15 } })

    const clearList = () => {
        let child = resultsList.get_first_child()
        while (child) { resultsList.remove(child); child = resultsList.get_first_child() }
    }

    const launchResult = (row: any) => {
        if ((row as any).fileUri) {
            execAsync(["xdg-open", (row as any).fileUri]).catch(console.error)
            return
        }
        const data = (row as any).appData as AppData
        if (data) {
            const appInfo = appService.getAppInfo(data.id)
            let cmd = appInfo?.get_commandline() || data.exec
            if (cmd) {
                cmd = cmd.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
                execAsync(["uwsm", "app", "--", "sh", "-c", cmd]).catch(console.error)
            }
        }
    }

    resultsList.connect("row-activated", (_, row) => {
        if (row && !(row as any).classList?.contains("prism-section-row")) {
            launchResult(row)
            status.prism_open = false
        }
    })

    entry.connect("changed", () => {
        const query = entry.text.trim()
        clearList()

        if (query.length === 0) { revealer.reveal_child = false; return }

        revealer.reveal_child = true

        // ── Apps ─────────────────────────────────────────────────────────────
        const appResults = appService.search(query)
        if (appResults.length > 0) {
            resultsList.append(SeparatorRow(t("prism.section.apps")))
            appResults.forEach(res => resultsList.append(AppResultRow(res)))
        }

        // ── Recent files ─────────────────────────────────────────────────────
        try {
            const recentMgr = Gtk.RecentManager.get_default()
            const lowerQuery = query.toLowerCase()
            const fileMatches = recentMgr.get_items()
                .filter(item => {
                    if (!item.exists()) return false
                    return item.get_display_name().toLowerCase().includes(lowerQuery) ||
                           (item.get_uri_display() || "").toLowerCase().includes(lowerQuery)
                })
                .slice(0, MAX_FILE_RESULTS)

            if (fileMatches.length > 0) {
                resultsList.append(SeparatorRow(t("prism.section.files")))
                fileMatches.forEach(item =>
                    resultsList.append(FileResultRow(item.get_uri(), item.get_display_name(), item.get_mime_type() || "application/octet-stream"))
                )
            }
        } catch (e) { console.error("[Prism] Recent files error:", e) }

        // Select first selectable row
        let first = resultsList.get_first_child()
        while (first && (first as Gtk.ListBoxRow).selectable === false) first = (first as any).get_next_sibling?.()
        if (first) resultsList.select_row(first as Gtk.ListBoxRow)
    })

    const key = new Gtk.EventControllerKey()
    key.connect("key-pressed", (_, keyval) => {
        if (keyval === Gdk.KEY_Escape) { status.prism_open = false; return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const s = resultsList.get_selected_row()
            if (s && (s as any).selectable !== false) { launchResult(s); status.prism_open = false; return true }
        }
        if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_Up) {
            const selected = resultsList.get_selected_row()
            if (!selected) {
                let first = resultsList.get_first_child()
                while (first && !(first as Gtk.ListBoxRow).selectable) first = (first as any).get_next_sibling?.()
                if (first) resultsList.select_row(first as Gtk.ListBoxRow)
                return true
            }
        }
        return false
    })
    prismWrapper.add_controller(key)

    const sync = () => {
        prismWrapper.set_visible(status.prism_open)
        if (status.prism_open) {
            entry.text = ""
            clearList()
            revealer.reveal_child = false
            entry.grab_focus()
        }
    }
    status.connect("notify::prism-open", sync)
    sync()

    return prismWrapper
}
