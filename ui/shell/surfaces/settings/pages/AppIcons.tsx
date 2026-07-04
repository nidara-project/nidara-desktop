import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import appService, { type AppData } from "../../../core/AppService"
import { pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { attachTooltip } from "../../../common/Tooltip"

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

function openIconPicker(app: AppData, onChanged: () => void, parent: Gtk.Window | null) {
    const originalIcon = app.icon ?? ""

    const dialog = new Gtk.Window({
        title: `${t("settings.apps.dialog.icon")} — ${app.name}`,
        default_width: 420,
        modal: true,
        resizable: false,
        css_classes: ["background", "glass", "nidara-settings-window"],
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

    // Preview of the current (or newly chosen) icon.
    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        halign: Gtk.Align.CENTER,
        margin_bottom: 18,
    })
    const previewImg = makeIconImage(appService.getCanonicalIconName(originalIcon), 72)
    previewImg.pixel_size = 72
    previewBox.append(previewImg)

    // The user picks an IMAGE FILE — never an icon-theme name. So we show the path
    // of the current override (or the newly chosen file), the only meaningful
    // identifier here. The old free-text "theme icon name" field was a power-user
    // trap (map an app to another themed icon by name) that just read as confusing.
    const currentOverride = appService.getIconOverridePath(originalIcon)
    const pathLabel = new Gtk.Label({
        label: currentOverride ?? "",
        css_classes: ["nidara-row-subtitle"],
        halign: Gtk.Align.CENTER,
        ellipsize: 3, // PANGO_ELLIPSIZE_END
        max_width_chars: 42,
        visible: !!currentOverride,
    })
    previewBox.append(pathLabel)
    box.append(previewBox)

    // Apply is declared first so the file picker's callback can enable it.
    let selectedPath: string | null = null
    const applyBtn = NidaraButton({
        label: t("settings.apps.apply"),
        variant: "primary",
        pill: true,
        sensitive: false, // enabled once an image is chosen
    })
    applyBtn.connect("clicked", () => {
        if (!selectedPath) { dialog.close(); return }
        const ok = appService.setIconOverride(originalIcon, selectedPath)
        if (ok) { onChanged(); dialog.close() }
        else { pathLabel.label = t("settings.apps.status.apply-failed"); pathLabel.visible = true }
    })

    // Choose image — the single, primary way to set an icon.
    const chooseBtn = NidaraButton({
        label: t("settings.apps.choose-image"),
        variant: "secondary",
        pill: true,
        halign: Gtk.Align.CENTER,
    })
    chooseBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("settings.apps.dialog.select-icon"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/svg+xml")
        filter.add_mime_type("image/png")
        filter.set_name(t("settings.apps.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        fd.set_filters(filters)
        fd.open(dialog, null, (_: any, res: any) => {
            try {
                const path = fd.open_finish(res)?.get_path()
                if (path) {
                    selectedPath = path
                    const pb = loadPixbuf(path, 72)
                    if (pb) previewImg.set_from_pixbuf(pb)
                    pathLabel.label = path
                    pathLabel.visible = true
                    applyBtn.sensitive = true
                }
            } catch {}
        })
    })
    box.append(chooseBtn)

    // Separator
    box.append(new Gtk.Separator({ margin_top: 16, margin_bottom: 16 }))

    // Action row: Restore (left) · Cancel · Apply (right).
    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })

    const resetBtn = NidaraButton({
        label: t("settings.apps.restore"),
        variant: "secondary",
        pill: true,
        sensitive: !!currentOverride,
    })
    attachTooltip(resetBtn, t("settings.apps.tooltip.remove-override"), { chrome: false })
    resetBtn.connect("clicked", () => {
        appService.removeIconOverride(originalIcon)
        onChanged()
        dialog.close()
    })

    const cancelBtn = NidaraButton({ label: t("settings.apps.cancel"), variant: "secondary", pill: true })
    cancelBtn.connect("clicked", () => dialog.close())

    btnRow.append(resetBtn)
    btnRow.append(cancelBtn)
    btnRow.append(applyBtn)
    box.append(btnRow)

    dialog.set_child(box)
    dialog.present()
}

// ── App row ───────────────────────────────────────────────────────────────────

function buildAppRow(app: AppData, parentWindow: Gtk.Window | null): Gtk.ListBoxRow {
    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
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
    textBox.append(new Gtk.Label({ label: app.name, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))

    const iconLabel = new Gtk.Label({
        label: canonical ?? (app.icon ?? t("settings.apps.no-icon")),
        halign: Gtk.Align.START,
        css_classes: ["nidara-row-subtitle"],
        ellipsize: 3, // PANGO_ELLIPSIZE_END
    })
    textBox.append(iconLabel)

    // Override badge
    const badge = new Gtk.Label({
        label: t("settings.apps.badge.override"),
        css_classes: ["nidara-row-subtitle", "app-override-badge"],
        visible: !!appService.getIconOverridePath(app.icon ?? ""),
        valign: Gtk.Align.CENTER,
    })

    // Re-reads fresh state (setIconOverride/removeIconOverride call reload()
    // synchronously) and re-syncs the whole row: icon, subtitle and badge. Passed
    // to the picker so apply/restore reflect immediately — the row's own app.icon
    // is a stale canonical snapshot (an override path, deleted on restore), so we
    // re-fetch the freshly re-canonicalized icon from the service by id.
    const syncRow = () => {
        const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
        // Sync the closure's app.icon with the freshly re-canonicalized value, so
        // RE-OPENING the picker resolves a live icon rather than a now-deleted
        // override path (which would render as a broken "not found" glyph).
        app.icon = iconRef
        const pb = loadPixbuf(iconRef, 32)
        if (pb) rowIcon.set_from_pixbuf(pb)
        else rowIcon.icon_name = iconRef ?? "application-x-executable"
        iconLabel.label = iconRef ?? t("settings.apps.no-icon")
        badge.visible = !!appService.getIconOverridePath(iconRef ?? "")
    }

    const editBtn = NidaraButton({
        label: t("settings.apps.change"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    editBtn.connect("clicked", () => {
        const win = row.get_root() as Gtk.Window | null
        openIconPicker(app, syncRow, win)
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

export default function AppIconsPage() {
    const page = pageBox("apps-page")

    // Search — custom box with our nd-icon magnifier + Gtk.Text. Gtk.SearchEntry
    // would force the icon theme's magnifier glyph; this matches the Settings
    // sidebar search (Settings.tsx) and the rest of the shell.
    const searchInput = new Gtk.Text({
        placeholder_text: t("settings.apps.entry.search"),
        css_classes: ["settings-search-text"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchEntry = new Gtk.Box({
        css_classes: ["settings-search"],
        spacing: 8,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        margin_bottom: 4,
    })
    searchEntry.append(new Gtk.Image({
        gicon: Icons.search,
        pixel_size: 15,
        css_classes: ["nd-icon", "settings-search-icon"],
        valign: Gtk.Align.CENTER,
    }))
    searchEntry.append(searchInput)

    page.append(searchEntry)

    // App list — build the group manually so we can wrap the ListBox in a ScrolledWindow.
    // spacing:0 to match NidaraList: the title→card gap is owned by .nidara-list-title's
    // margin-bottom, so the header binds to its card (see design-system.md).
    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["nidara-list-group"] })
    groupBox.append(new Gtk.Label({
        label: t("settings.apps.installed"),
        css_classes: ["nidara-list-title"],
        halign: Gtk.Align.START,
        margin_start: 10,
    }))

    // No card chrome on the ListBox itself — it SCROLLS, so its rounded top/bottom
    // would scroll out of the viewport (the "cut-off background" bug). The card
    // lives on the fixed ScrolledWindow below (.apps-list-scroll); the list is
    // transparent and just scrolls inside it.
    const appList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ["apps-list"],
    })

    const apps = appService.getAllApps()
    apps.forEach(app => appList.append(buildAppRow(app, null)))

    // Filter
    appList.set_filter_func((row: Gtk.ListBoxRow) => {
        const q = searchInput.text.trim().toLowerCase()
        if (!q) return true
        const r = row as any
        return r._appName?.includes(q) || r._appId?.includes(q)
    })
    searchInput.connect("changed", () => appList.invalidate_filter())

    const scroll = new Gtk.ScrolledWindow({
        vexpand: true,
        min_content_height: 400,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        // Non-overlay: the scrollbar takes its own gutter instead of floating over
        // the rows' right edge (where the "Change icon" button sits) and covering it.
        overlay_scrolling: false,
        css_classes: ["apps-list-scroll"],
    })
    scroll.set_child(appList)
    groupBox.append(scroll)

    page.append(groupBox)

    return page
}
