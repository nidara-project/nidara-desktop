import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { listGroup, createRow, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

// Build a dropdown row backed by GIO app list for a given MIME type.
// Returns null if no apps are registered for the type.
function appRow(
    label: string,
    subtitle: string,
    mimeType: string,
    mustSupportUris = false,
): Gtk.Widget | null {
    const all = Gio.AppInfo.get_all_for_type(mimeType)
    if (!all || all.length === 0) return null

    // Deduplicate by name (multiple .desktop entries can share a name)
    const seen = new Set<string>()
    const apps = all.filter(a => {
        const n = a.get_name()
        if (!n || seen.has(n)) return false
        seen.add(n)
        return true
    })
    if (apps.length === 0) return null

    const names = apps.map(a => a.get_name()!)
    const def   = Gio.AppInfo.get_default_for_type(mimeType, mustSupportUris)
    const defName = def?.get_name() ?? names[0]
    // Make sure defName is in the list (it might be filtered out)
    const initName = names.includes(defName) ? defName : names[0]

    const model = new Gtk.StringList({ strings: names })
    const drp = new Gtk.DropDown({ model, valign: Gtk.Align.CENTER })
    drp.selected = Math.max(0, names.indexOf(initName))

    drp.connect("notify::selected", () => {
        const selectedName = names[drp.selected]
        if (!selectedName) return
        const app = apps.find(a => a.get_name() === selectedName)
        if (!app) return
        try { app.set_as_default_for_type(mimeType) } catch (e) {
            console.error("[DefaultApps] set_as_default_for_type:", e)
        }
    })

    return createRow(label, subtitle, drp)
}

export default function DefaultAppsPage() {
    const page = pageBox("defaultapps-page")

    // ── Web ──────────────────────────────────────────────────────────────────
    const webGroup = listGroup(t("settings.defaultapps.group.web"))
    const browserRow = appRow(t("settings.defaultapps.browser"), t("settings.defaultapps.browser.desc"), "text/html", true)
    const emailRow   = appRow(t("settings.defaultapps.email"),   t("settings.defaultapps.email.desc"),   "x-scheme-handler/mailto")
    if (browserRow) webGroup.listBox.append(browserRow)
    if (emailRow)   webGroup.listBox.append(emailRow)
    if (webGroup.listBox.get_first_child()) page.append(webGroup.box)

    // ── Files & Media ─────────────────────────────────────────────────────────
    const mediaGroup = listGroup(t("settings.defaultapps.group.media"))
    const rows: Array<Gtk.Widget | null> = [
        appRow(t("settings.defaultapps.files"),   t("settings.defaultapps.files.desc"),   "inode/directory"),
        appRow(t("settings.defaultapps.images"),  t("settings.defaultapps.images.desc"),  "image/jpeg"),
        appRow(t("settings.defaultapps.video"),   t("settings.defaultapps.video.desc"),   "video/mp4"),
        appRow(t("settings.defaultapps.music"),   t("settings.defaultapps.music.desc"),   "audio/mpeg"),
        appRow(t("settings.defaultapps.pdf"),     t("settings.defaultapps.pdf.desc"),     "application/pdf"),
        appRow(t("settings.defaultapps.archive"), t("settings.defaultapps.archive.desc"), "application/zip"),
    ]
    rows.forEach(r => r && mediaGroup.listBox.append(r))
    if (mediaGroup.listBox.get_first_child()) page.append(mediaGroup.box)

    // ── Text & Code ────────────────────────────────────────────────────────────
    const textGroup = listGroup(t("settings.defaultapps.group.text"))
    const editorRow   = appRow(t("settings.defaultapps.editor"),   t("settings.defaultapps.editor.desc"),   "text/plain")
    const calendarRow = appRow(t("settings.defaultapps.calendar"), t("settings.defaultapps.calendar.desc"), "text/calendar")
    if (editorRow)   textGroup.listBox.append(editorRow)
    if (calendarRow) textGroup.listBox.append(calendarRow)
    if (textGroup.listBox.get_first_child()) page.append(textGroup.box)

    return page
}
