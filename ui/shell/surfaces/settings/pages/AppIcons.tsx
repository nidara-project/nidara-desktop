import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import appService, { type AppData } from "../../../core/AppService"
import { pageBox, listGroup, createRow, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { attachTooltip } from "../../../common/Tooltip"
import { loadPixbuf, makeIconImage } from "./AppIconImage"

// ── Per-app detail subpage ──────────────────────────────────────────────────────
// Each app drills into its own subpage (nav.pushSubpage) rather than a modal — more
// room, and a foundation for future per-app settings beyond just the icon. Changes
// apply immediately (no Apply/Cancel step), matching every other Settings row.

function buildAppIconDetailPage(app: AppData, syncRow: () => void): Gtk.Widget {
    const page = pageBox("app-icon-detail-page")
    const { box, listBox } = listGroup(t("settings.apps.detail.group.icon"))

    const preview = new Gtk.Image({ pixel_size: 40, valign: Gtk.Align.CENTER })
    const refreshPreview = () => {
        // Re-reads fresh state the same way the row's syncRow does — app.icon gets
        // canonicalized to the override path once one exists, so re-fetch by id
        // rather than trust the (possibly now-stale) closure value.
        const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
        app.icon = iconRef
        const pb = loadPixbuf(iconRef, 40)
        if (pb) preview.set_from_pixbuf(pb)
        else preview.icon_name = iconRef ?? "application-x-executable"
    }
    refreshPreview()

    const resetBtn = NidaraButton({
        label: t("settings.apps.restore"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        sensitive: !!appService.getIconOverridePath(app.icon ?? ""),
    })
    attachTooltip(resetBtn, t("settings.apps.tooltip.remove-override"), { chrome: false })
    resetBtn.connect("clicked", () => {
        appService.removeIconOverride(app.icon ?? "")
        refreshPreview()
        resetBtn.sensitive = false
        syncRow()
    })

    // Choose image — the single, primary way to set an icon. The user picks an
    // IMAGE FILE — never an icon-theme name (a prior free-text field was a
    // confusing power-user trap; prior art macOS/Windows/GNOME = pick an image).
    const chooseBtn = NidaraButton({
        label: t("settings.apps.choose-image"),
        variant: "primary",
        pill: true,
        valign: Gtk.Align.CENTER,
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
        const win = chooseBtn.get_root() as Gtk.Window | null
        fd.open(win, null, (_: any, res: any) => {
            try {
                const path = fd.open_finish(res)?.get_path()
                if (!path) return
                const ok = appService.setIconOverride(app.icon ?? "", path)
                if (ok) {
                    refreshPreview()
                    resetBtn.sensitive = true
                    syncRow()
                }
            } catch {}
        })
    })

    const controlBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    controlBox.append(preview)
    controlBox.append(chooseBtn)
    controlBox.append(resetBtn)

    listBox.append(createRow(t("settings.apps.dialog.icon"), t("settings.apps.detail.icon.desc"), controlBox))
    page.append(box)

    return page
}

// ── App row ───────────────────────────────────────────────────────────────────

function buildAppRow(app: AppData, nav: SettingsNav): Gtk.ListBoxRow {
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

    const idLabel = new Gtk.Label({
        label: app.id,
        halign: Gtk.Align.START,
        css_classes: ["nidara-row-subtitle"],
        ellipsize: 3, // PANGO_ELLIPSIZE_END
    })
    textBox.append(idLabel)

    // Override badge
    const badge = new Gtk.Label({
        label: t("settings.apps.badge.override"),
        css_classes: ["nidara-row-subtitle", "app-override-badge"],
        visible: !!appService.getIconOverridePath(app.icon ?? ""),
        valign: Gtk.Align.CENTER,
    })

    // Re-reads fresh state (setIconOverride/removeIconOverride call reload()
    // synchronously) and re-syncs the row's icon + badge. Passed to the detail
    // page so apply/restore reflect immediately — the row's own app.icon is a
    // stale canonical snapshot (an override path, deleted on restore), so we
    // re-fetch the freshly re-canonicalized icon from the service by id. (The
    // id subtitle never changes, so it's not touched here.)
    const syncRow = () => {
        const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
        // Sync the closure's app.icon with the freshly re-canonicalized value, so
        // RE-OPENING the picker resolves a live icon rather than a now-deleted
        // override path (which would render as a broken "not found" glyph).
        app.icon = iconRef
        const pb = loadPixbuf(iconRef, 32)
        if (pb) rowIcon.set_from_pixbuf(pb)
        else rowIcon.icon_name = iconRef ?? "application-x-executable"
        badge.visible = !!appService.getIconOverridePath(iconRef ?? "")
    }

    // Each row drills into its own subpage (nav.pushSubpage) — see
    // buildAppIconDetailPage. Decorative chevron mirrors Apps.tsx's navRow; the
    // whole row is the click target since nothing else in it is interactive.
    const chevron = new Gtk.Image({
        gicon: Icons.chevronRight, pixel_size: 16,
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
    })

    box.append(rowIcon)
    box.append(textBox)
    box.append(badge)
    box.append(chevron)
    row.set_child(box)
    row.set_cursor_from_name("pointer")

    const click = new Gtk.GestureClick()
    click.connect("released", () => {
        nav.pushSubpage({
            id: `apps/icons/${app.id}`,
            title: app.name,
            parentId: "apps/icons",
            build: () => buildAppIconDetailPage(app, syncRow),
        })
    })
    row.add_controller(click)

    // Tag for filter
    ;(row as any)._appName = app.name.toLowerCase()
    ;(row as any)._appId = app.id.toLowerCase()

    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AppIconsPage(nav: SettingsNav) {
    const page = pageBox("apps-page")

    // NOTE: the search box + scrollable app list below are intentionally duplicated
    // in Autostart.tsx's app picker (same classes, same filter idiom) — the scaffold
    // carries page-specific tuning and hard-won fixes. On a THIRD consumer, extract
    // a shared builder instead of copying again.

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
    // No title label: the page's own breadcrumb already reads "Installed Apps"
    // (settings.apps.title), so a group header repeating it would be redundant —
    // same call NidaraList makes when passed an empty title (list.ts).
    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["nidara-list-group"] })

    // No card chrome on the ListBox itself — it SCROLLS, so its rounded top/bottom
    // would scroll out of the viewport (the "cut-off background" bug). The card
    // lives on the fixed ScrolledWindow below (.apps-list-scroll); the list is
    // transparent and just scrolls inside it.
    const appList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ["apps-list"],
    })

    const apps = appService.getAllApps()
    apps.forEach(app => appList.append(buildAppRow(app, nav)))

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
        // the rows' right edge (where the chevron sits) and covering it.
        overlay_scrolling: false,
        css_classes: ["apps-list-scroll"],
    })
    scroll.set_child(appList)
    groupBox.append(scroll)

    page.append(groupBox)

    return page
}
