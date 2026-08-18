import Gtk from "gi://Gtk?version=4.0"
import { NidaraScrolled, NidaraRow } from "../../../../lib/nidara-kit"
import appService, { type AppData } from "../../../core/AppService"
import { pageBox, listGroup, imagePickerRow, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { loadPixbuf, makeIconImage } from "./AppIconImage"

// ── Per-app detail subpage ──────────────────────────────────────────────────────
// Each app drills into its own subpage (nav.pushSubpage) rather than a modal — more
// room, and a foundation for future per-app settings beyond just the icon. Changes
// apply immediately (no Apply/Cancel step), matching every other Settings row.

function buildAppIconDetailPage(app: AppData, syncRow: () => void): Gtk.Widget {
    const page = pageBox("app-icon-detail-page")
    const { box, listBox } = listGroup(t("settings.apps.detail.group.icon"))

    // Choose image — the single, primary way to set an icon. The user picks an
    // IMAGE FILE — never an icon-theme name (a prior free-text field was a
    // confusing power-user trap; prior art macOS/Windows/GNOME = pick an image).
    // The row shape (preview leading, text, buttons trailing) and the dialog live
    // in `imagePickerRow`; only what the icon IS and what setting one does are here.
    listBox.append(imagePickerRow(
        t("settings.apps.dialog.icon"),
        t("settings.apps.detail.icon.desc"),
        {
            renderPreview: (img) => {
                // Re-reads fresh state the same way the row's syncRow does — app.icon
                // gets canonicalized to the override path once one exists, so re-fetch
                // by id rather than trust the (possibly now-stale) closure value.
                const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
                app.icon = iconRef
                const pb = loadPixbuf(iconRef, 40)
                if (pb) img.set_from_pixbuf(pb)
                else img.icon_name = iconRef ?? "application-x-executable"
            },
            isCustom: () => !!appService.getIconOverridePath(app.icon ?? ""),
            onPick: (path) => {
                if (!appService.setIconOverride(app.icon ?? "", path)) return false
                syncRow()
            },
            onReset: () => { appService.removeIconOverride(app.icon ?? ""); syncRow() },
            resetLabel: t("settings.apps.restore"),
            resetTooltip: t("settings.apps.tooltip.remove-override"),
            // The icon IS the subject of this page, so it gets more room than the
            // 32px app-identity default.
            previewSize: 40,
        },
    ))
    page.append(box)

    return page
}

// ── App row ───────────────────────────────────────────────────────────────────

function buildAppRow(app: AppData, nav: SettingsNav): Gtk.ListBoxRow {
    const canonical = appService.getCanonicalIconName(app.icon ?? "")
    const rowIcon = makeIconImage(canonical, 32)

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

    const trailing = new Gtk.Box({ spacing: 16, valign: Gtk.Align.CENTER })
    trailing.append(badge)
    trailing.append(chevron)

    // NidaraRow, not createRow: this list is every installed app, rebuilt from the
    // app service — the search index holds settings, not the machine's contents.
    // The `.desktop` id rides as the subtitle, so it now wraps in the column instead
    // of ellipsising at its own natural width.
    const row = NidaraRow(app.name, app.id, trailing, [], undefined, rowIcon)
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

    // NidaraScrolled reserves the lane itself, so the rows' trailing chevron is never
    // under the bar — that is what `overlay_scrolling: false` used to buy, without
    // the gutter appearing and resizing the list the moment it starts overflowing.
    const { widget: scrollWidget, scrolled: scroll } = NidaraScrolled({
        child: appList,
        minContentHeight: 400,
        cssClasses: ["apps-list-scroll"],
    })
    scroll.vexpand = true; scrollWidget.vexpand = true
    groupBox.append(scrollWidget)

    page.append(groupBox)

    return page
}
