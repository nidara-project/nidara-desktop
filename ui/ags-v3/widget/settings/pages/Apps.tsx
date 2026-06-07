import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import appService, { type AppData } from "../../../core/AppService"
import { pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { CrystalButton } from "../../../../lib/crystal-ui"

// ── Icon preview helpers ──────────────────────────────────────────────────────

function loadPixbuf(iconName: string | null, size: number): GdkPixbuf.Pixbuf | null {
    if (!iconName) return null
    try {
        if (iconName.startsWith("/")) {
            return GdkPixbuf.Pixbuf.new_from_file_at_size(iconName, size, size)
        }
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        const paintable = theme.lookup_icon(iconName, null, size, 1, Gtk.TextDirection.LTR,
            Gtk.IconLookupFlags.FORCE_REGULAR)
        const path = paintable?.get_file()?.get_path()
        if (path) return GdkPixbuf.Pixbuf.new_from_file_at_size(path, size, size)
    } catch {}
    return null
}

function makeIconImage(iconName: string | null, size: number): Gtk.Image {
    const img = new Gtk.Image({ pixel_size: size })
    const pb = loadPixbuf(iconName, size)
    if (pb) img.set_from_pixbuf(pb)
    else img.icon_name = iconName ?? "application-x-executable"
    return img
}

// ── Icon picker dialog ────────────────────────────────────────────────────────

function openIconPicker(app: AppData, rowIcon: Gtk.Image, rowIconLabel: Gtk.Label, parent: Gtk.Window | null) {
    const originalIcon = app.icon ?? ""

    const dialog = new Gtk.Window({
        title: `${t("settings.apps.dialog.icon")} — ${app.name}`,
        default_width: 420,
        modal: true,
        resizable: false,
        css_classes: ["background", "glass", "crystal-settings-window"],
        transient_for: parent ?? undefined,
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        margin_start: 24,
        margin_end: 24,
        margin_top: 24,
        margin_bottom: 20,
    })

    // Preview area
    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        halign: Gtk.Align.CENTER,
        margin_bottom: 20,
    })
    const previewImg = makeIconImage(appService.getCanonicalIconName(originalIcon), 72)
    previewImg.pixel_size = 72
    previewBox.append(previewImg)

    const previewStatus = new Gtk.Label({
        label: "",
        css_classes: ["crystal-row-subtitle"],
        halign: Gtk.Align.CENTER,
    })
    previewBox.append(previewStatus)
    box.append(previewBox)

    // Current icon name hint
    box.append(new Gtk.Label({
        label: t("settings.apps.theme-icon-name"),
        css_classes: ["crystal-list-title"],
        halign: Gtk.Align.START,
        margin_bottom: 6,
    }))

    // Icon name entry
    const entry = new Gtk.Entry({
        placeholder_text: originalIcon || t("settings.apps.entry.icon-name"),
        hexpand: true,
    })
    if (originalIcon) entry.text = originalIcon
    box.append(entry)

    // Live preview on entry change
    let previewTimeout = 0
    const updatePreview = (iconInput: string) => {
        if (previewTimeout) { GLib.source_remove(previewTimeout); previewTimeout = 0 }
        previewTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            previewTimeout = 0
            if (!iconInput.trim()) { previewStatus.label = ""; return GLib.SOURCE_REMOVE }
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
            const isFile = iconInput.startsWith("/") && GLib.file_test(iconInput, GLib.FileTest.EXISTS)
            const isThemed = theme.has_icon(iconInput)
            if (isFile || isThemed) {
                const pb = loadPixbuf(iconInput.startsWith("/") ? iconInput : iconInput, 72)
                if (pb) previewImg.set_from_pixbuf(pb)
                previewStatus.label = isFile ? t("settings.apps.status.custom-file") : t("settings.apps.status.in-theme")
                entry.remove_css_class("error")
            } else {
                previewStatus.label = t("settings.apps.status.not-in-theme")
                entry.add_css_class("error")
            }
            return GLib.SOURCE_REMOVE
        })
    }
    entry.connect("changed", () => updatePreview(entry.text))

    // File picker button
    const fileBtn = CrystalButton({
        label: t("settings.apps.from-file"),
        variant: "secondary",
        pill: true,
        halign: Gtk.Align.START,
    })
    fileBtn.margin_top = 10
    fileBtn.margin_bottom = 4
    fileBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("settings.apps.dialog.select-icon"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/svg+xml")
        filter.add_mime_type("image/png")
        filter.set_name(t("settings.apps.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        fd.set_filters(filters)
        // Parent to the Settings window so it floats/centers over it (not tiled).
        fd.open(fileBtn.get_root() as Gtk.Window, null, (_: any, res: any) => {
            try {
                const path = fd.open_finish(res)?.get_path()
                if (path) { entry.text = path; updatePreview(path) }
            } catch {}
        })
    })
    box.append(fileBtn)

    // Separator
    box.append(new Gtk.Separator({ margin_top: 16, margin_bottom: 16 }))

    // Buttons row
    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })

    const hasOverride = !!appService.getIconOverridePath(originalIcon)
    const resetBtn = CrystalButton({
        label: t("settings.apps.restore"),
        variant: "secondary",
        pill: true,
        sensitive: hasOverride,
        tooltip_text: t("settings.apps.tooltip.remove-override"),
    })
    resetBtn.connect("clicked", () => {
        appService.removeIconOverride(originalIcon)
        // Refresh row
        const canonical = appService.getCanonicalIconName(originalIcon)
        const pb = loadPixbuf(canonical, 32)
        if (pb) rowIcon.set_from_pixbuf(pb)
        else rowIcon.icon_name = canonical ?? "application-x-executable"
        rowIconLabel.label = canonical ?? originalIcon
        dialog.close()
    })

    const cancelBtn = CrystalButton({ label: t("settings.apps.cancel"), variant: "secondary", pill: true })
    cancelBtn.connect("clicked", () => dialog.close())

    const applyBtn = CrystalButton({ label: t("settings.apps.apply"), variant: "primary", pill: true })
    applyBtn.connect("clicked", () => {
        const val = entry.text.trim()
        if (!val) { dialog.close(); return }
        const ok = appService.setIconOverride(originalIcon, val)
        if (ok) {
            const canonical = appService.getCanonicalIconName(originalIcon)
            const pb = loadPixbuf(canonical, 32)
            if (pb) rowIcon.set_from_pixbuf(pb)
            else rowIcon.icon_name = canonical ?? "application-x-executable"
            rowIconLabel.label = canonical ?? originalIcon
            dialog.close()
        } else {
            previewStatus.label = t("settings.apps.status.apply-failed")
        }
    })

    btnRow.append(resetBtn)
    btnRow.append(cancelBtn)
    btnRow.append(applyBtn)
    box.append(btnRow)

    dialog.set_child(box)
    dialog.present()
}

// ── App row ───────────────────────────────────────────────────────────────────

function buildAppRow(app: AppData, parentWindow: Gtk.Window | null): Gtk.ListBoxRow {
    const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
    const box = new Gtk.Box({
        spacing: 14,
        margin_start: 14,
        margin_end: 12,
        margin_top: 10,
        margin_bottom: 10,
    })

    const canonical = appService.getCanonicalIconName(app.icon ?? "")
    const rowIcon = makeIconImage(canonical, 32)

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER })
    textBox.append(new Gtk.Label({ label: app.name, halign: Gtk.Align.START, css_classes: ["crystal-row-title"] }))

    const iconLabel = new Gtk.Label({
        label: canonical ?? (app.icon ?? t("settings.apps.no-icon")),
        halign: Gtk.Align.START,
        css_classes: ["crystal-row-subtitle"],
        ellipsize: 3, // PANGO_ELLIPSIZE_END
    })
    textBox.append(iconLabel)

    // Override badge
    const hasOverride = !!appService.getIconOverridePath(app.icon ?? "")
    const badge = new Gtk.Label({
        label: t("settings.apps.badge.override"),
        css_classes: ["crystal-row-subtitle", "app-override-badge"],
        visible: hasOverride,
        valign: Gtk.Align.CENTER,
    })

    const editBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.filePen, pixel_size: 14 , css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn"],
        valign: Gtk.Align.CENTER,
        tooltip_text: t("settings.apps.tooltip.change-icon"),
    })
    editBtn.connect("clicked", () => {
        const win = row.get_root() as Gtk.Window | null
        openIconPicker(app, rowIcon, iconLabel, win)
    })

    box.append(rowIcon)
    box.append(textBox)
    box.append(badge)
    box.append(editBtn)
    row.set_child(box)

    // Tag for filter
    ;(row as any)._appName = app.name.toLowerCase()
    ;(row as any)._appId = app.id.toLowerCase()

    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AppsPage() {
    const page = pageBox("apps-page")

    // Search
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: t("settings.apps.entry.search"),
        hexpand: true,
        margin_bottom: 4,
    })

    page.append(searchEntry)

    // App list — build the group manually so we can wrap the ListBox in a ScrolledWindow
    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["crystal-list-group"] })
    groupBox.append(new Gtk.Label({
        label: t("settings.apps.installed"),
        css_classes: ["crystal-list-title"],
        halign: Gtk.Align.START,
        margin_start: 10,
    }))

    const appList = new Gtk.ListBox({
        css_classes: ["crystal-list", "boxed-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    const apps = appService.getAllApps()
    apps.forEach(app => appList.append(buildAppRow(app, null)))

    // Filter
    appList.set_filter_func((row: Gtk.ListBoxRow) => {
        const q = searchEntry.text.trim().toLowerCase()
        if (!q) return true
        const r = row as any
        return r._appName?.includes(q) || r._appId?.includes(q)
    })
    searchEntry.connect("search-changed", () => appList.invalidate_filter())

    const scroll = new Gtk.ScrolledWindow({
        vexpand: true,
        min_content_height: 400,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    })
    scroll.set_child(appList)
    groupBox.append(scroll)

    page.append(groupBox)

    return page
}
