import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { listGroup, createRow, pageBox } from "../SettingsHelpers"
import { NidaraDropDown } from "../../../../lib/nidara-kit"
import { t } from "../../../core/i18n"

// A row here is a CATEGORY ("Image viewer", "Opens photos and images"), not a
// single content type — which is what the subtitles have always promised. Each
// one therefore carries a LIST of types:
//
//   • the FIRST type defines the category — it is what the app list is enumerated
//     from and what the current default is read from;
//   • picking an app writes the default for EVERY type in the list that the app
//     declares support for.
//
// Both halves used to be wrong with one type per row. Writing only `image/jpeg`
// meant a PNG still opened in the previous viewer; and for the browser it was
// worse than partial — the row wrote `text/html`, while `xdg-settings` and every
// app that opens a link read `x-scheme-handler/http`, so the choice never left
// this page. Enumerating from `text/html` was the same mistake seen from the
// other side: on a normal Arch install it offers micro, nvim and Text Editor as
// "web browsers", because a text editor legitimately claims to open HTML.
//
// ⚠️ The support filter is not optional. `set_as_default_for_type` happily makes
// an app the default for a type it cannot open (it just appends an association),
// so writing the whole list blind would break the types the chosen app doesn't
// handle. Only types the app already appears under are written.
//
// Types deliberately left OUT of a list are as much a decision as the ones in it:
// `image/svg+xml` is not in the image list because "view" and "edit" genuinely
// diverge there (a vector editor is a reasonable SVG default while Loupe is the
// reasonable photo default), and nothing forces the user to accept one for both.
interface AppCategory {
    label: string
    subtitle: string
    /** First = the defining type. All are written when supported. */
    types: string[]
    mustSupportUris?: boolean
}

// Build a dropdown row backed by the GIO app list for a category.
// Returns null if no apps are registered for its defining type.
function appRow(cat: AppCategory): Gtk.Widget | null {
    const primary = cat.types[0]
    const all = Gio.AppInfo.get_all_for_type(primary)
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
    // No explicit default is not a gap to paper over: GIO falls back to the first
    // recommended app, which IS what would open the file, so this stays truthful.
    const def   = Gio.AppInfo.get_default_for_type(primary, cat.mustSupportUris ?? false)
    const defName = def?.get_name() ?? names[0]
    // Make sure defName is in the list (it might be filtered out)
    const initName = names.includes(defName) ? defName : names[0]

    const model = new Gtk.StringList({ strings: names })
    const drp = NidaraDropDown({ model, valign: Gtk.Align.CENTER })
    drp.selected = Math.max(0, names.indexOf(initName))

    // The set of ids registered for a type, so "does this app handle it?" is a
    // lookup rather than a guess. Read per change, not cached: the answer moves
    // when apps are installed, and this runs once per user click.
    const supports = (app: Gio.AppInfo, type: string): boolean => {
        const id = app.get_id()
        if (!id) return false
        return (Gio.AppInfo.get_all_for_type(type) ?? []).some(a => a.get_id() === id)
    }

    drp.connect("notify::selected", () => {
        const selectedName = names[drp.selected]
        if (!selectedName) return
        const app = apps.find(a => a.get_name() === selectedName)
        if (!app) return
        for (const type of cat.types) {
            if (type !== primary && !supports(app, type)) continue
            try { app.set_as_default_for_type(type) } catch (e) {
                console.error(`[DefaultApps] set_as_default_for_type(${type}):`, e)
            }
        }
    })

    return createRow(cat.label, cat.subtitle, drp)
}

export default function DefaultAppsPage() {
    const page = pageBox("defaultapps-page")

    const group = (title: string, cats: AppCategory[]) => {
        const { box, listBox } = listGroup(title)
        cats.forEach(c => { const row = appRow(c); if (row) listBox.append(row) })
        if (listBox.get_first_child()) page.append(box)
    }

    // ── Web ──────────────────────────────────────────────────────────────────
    group(t("settings.defaultapps.group.web"), [
        {
            label: t("settings.defaultapps.browser"),
            subtitle: t("settings.defaultapps.browser.desc"),
            // http first: it is the type that MAKES an app the browser (what
            // `xdg-settings get default-web-browser` reads), and the only one of
            // the three that no text editor claims.
            types: ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"],
            mustSupportUris: true,
        },
        {
            label: t("settings.defaultapps.email"),
            subtitle: t("settings.defaultapps.email.desc"),
            types: ["x-scheme-handler/mailto"],
        },
    ])

    // ── Files & Media ─────────────────────────────────────────────────────────
    group(t("settings.defaultapps.group.media"), [
        {
            label: t("settings.defaultapps.files"),
            subtitle: t("settings.defaultapps.files.desc"),
            types: ["inode/directory"],
        },
        {
            label: t("settings.defaultapps.images"),
            subtitle: t("settings.defaultapps.images.desc"),
            types: ["image/jpeg", "image/png", "image/gif", "image/webp",
                    "image/tiff", "image/bmp", "image/x-portable-pixmap"],
        },
        {
            label: t("settings.defaultapps.video"),
            subtitle: t("settings.defaultapps.video.desc"),
            types: ["video/mp4", "video/x-matroska", "video/webm", "video/quicktime",
                    "video/x-msvideo", "video/mpeg", "video/ogg"],
        },
        {
            label: t("settings.defaultapps.music"),
            subtitle: t("settings.defaultapps.music.desc"),
            types: ["audio/mpeg", "audio/flac", "audio/ogg", "audio/x-vorbis+ogg",
                    "audio/mp4", "audio/x-wav", "audio/aac", "audio/x-opus+ogg"],
        },
        {
            label: t("settings.defaultapps.pdf"),
            subtitle: t("settings.defaultapps.pdf.desc"),
            types: ["application/pdf"],
        },
        {
            label: t("settings.defaultapps.archive"),
            subtitle: t("settings.defaultapps.archive.desc"),
            types: ["application/zip", "application/x-compressed-tar", "application/x-tar",
                    "application/gzip", "application/x-7z-compressed", "application/vnd.rar",
                    "application/x-xz-compressed-tar", "application/x-bzip-compressed-tar"],
        },
    ])

    // ── Text & Code ────────────────────────────────────────────────────────────
    group(t("settings.defaultapps.group.text"), [
        {
            label: t("settings.defaultapps.editor"),
            subtitle: t("settings.defaultapps.editor.desc"),
            // Kept to what "plain text files" means. Source-code types are NOT
            // here: an editor claiming text/x-csrc is not a reason to take that
            // association away from an IDE the user chose deliberately.
            types: ["text/plain", "text/markdown"],
        },
        {
            label: t("settings.defaultapps.calendar"),
            subtitle: t("settings.defaultapps.calendar.desc"),
            types: ["text/calendar"],
        },
    ])

    return page
}
