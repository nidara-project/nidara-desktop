import { Astal, Gtk, Gdk } from "ags/gtk4"
import { ScaleRevealer, OVERLAY_POP } from "../../common/ScaleRevealer"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import appService, { AppData } from "../../core/AppService"
import status from "../../core/Status"
import SquircleContainer from "../../common/SquircleContainer"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

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
    const row = new Gtk.ListBoxRow({ child: box, css_classes: ["prism-section-row"], selectable: false, activatable: false, focusable: false })
    return row
}

export default function Prism() {
    const entry = new Gtk.Text({
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
    searchContainer.append(new Gtk.Image({ gicon: Icons.search, pixel_size: 20 , css_classes: ["cs-icon"] }))
    searchContainer.append(entry)
    contentBox.append(searchContainer)
    contentBox.append(revealer)

    const prismWrapper = SquircleContainer({ child: contentBox, radius: 32, n: 4.5, css_classes: ["prism-wrapper"], useShellOpacity: true, gloss: true, borderColor: { r: 1, g: 1, b: 1, a: 0.15 } })

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

    // Find the first selectable row, or the next/prev selectable sibling — so
    // arrow nav skips section headers (selectable:false) entirely.
    const firstSelectable = (): Gtk.ListBoxRow | null => {
        let r: any = resultsList.get_first_child()
        while (r && (r as Gtk.ListBoxRow).selectable === false) r = r.get_next_sibling?.()
        return (r as Gtk.ListBoxRow) ?? null
    }
    const siblingSelectable = (row: Gtk.ListBoxRow, dir: 1 | -1): Gtk.ListBoxRow | null => {
        let r: any = row
        do { r = dir === 1 ? r.get_next_sibling?.() : r.get_prev_sibling?.() }
        while (r && (r as Gtk.ListBoxRow).selectable === false)
        return (r as Gtk.ListBoxRow) ?? null
    }

    const key = new Gtk.EventControllerKey()
    key.connect("key-pressed", (_, keyval) => {
        if (keyval === Gdk.KEY_Escape) { status.prism_open = false; return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const s = resultsList.get_selected_row()
            if (s && (s as any).selectable !== false) { launchResult(s); status.prism_open = false; return true }
            return false
        }
        // Own arrow nav fully: move SELECTION (not focus), skipping headers, so
        // focus stays on the entry (keep typing) and you never "land" on a title.
        if (keyval === Gdk.KEY_Down) {
            const sel = resultsList.get_selected_row() as Gtk.ListBoxRow | null
            const next = sel ? siblingSelectable(sel, 1) : firstSelectable()
            if (next) resultsList.select_row(next)
            return true
        }
        if (keyval === Gdk.KEY_Up) {
            const sel = resultsList.get_selected_row() as Gtk.ListBoxRow | null
            if (sel) {
                const prev = siblingSelectable(sel, -1)
                if (prev) resultsList.select_row(prev)
                else resultsList.unselect_all()   // above the first result → back to the search field
            }
            return true
        }
        return false
    })
    prismWrapper.add_controller(key)

    // Visibility/animation is driven by the bar (popToggle on the returned
    // ScaleRevealer); this handler only resets the search state. The focus grab
    // is deferred one frame because the bar's notify handler (which makes the
    // wrapper visible) connects AFTER this one and runs second.
    const sync = () => {
        if (status.prism_open) {
            entry.text = ""
            clearList()
            revealer.reveal_child = false
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => { if (status.prism_open) entry.grab_focus(); return GLib.SOURCE_REMOVE })
        }
    }
    status.connect("notify::prism-open", sync)

    return new ScaleRevealer(prismWrapper, { ...OVERLAY_POP, pivot: "center" })
}
