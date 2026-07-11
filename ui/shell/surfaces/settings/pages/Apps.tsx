import { Gtk } from "ags/gtk4"
import { listGroup, createRow, pageBox, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import DefaultAppsPage from "./DefaultApps"
import AppIconsPage from "./AppIcons"
import AutostartPage from "./Autostart"

// Apps landing — a parent page that drills into the three app-related screens
// (Default Apps, App Icons, Autostart) via subpages, so they share one sidebar
// entry. Note: subpage content isn't in the search index (subpages build lazily);
// the rows below are, so a search for "default apps"/"autostart" still lands here.

function navRow(
    nav: SettingsNav,
    label: string,
    subtitle: string,
    sub: { id: string; build: () => Gtk.Widget },
): Gtk.ListBoxRow {
    const chevron = new Gtk.Image({
        gicon: Icons.chevronRight, pixel_size: 16,
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
    })
    const row = createRow(label, subtitle, chevron)
    row.set_cursor_from_name("pointer")

    const click = new Gtk.GestureClick()
    click.connect("released", () => {
        nav.pushSubpage({ id: sub.id, title: label, parentId: "apps", build: sub.build })
    })
    row.add_controller(click)
    return row
}

export default function AppsPage(nav: SettingsNav) {
    const page = pageBox("apps-page")
    const { box, listBox } = listGroup("")

    listBox.append(navRow(
        nav,
        t("settings.defaultapps.title"),
        t("settings.defaultapps.subtitle"),
        { id: "apps/default", build: () => DefaultAppsPage() },
    ))
    listBox.append(navRow(
        nav,
        t("settings.apps.title"),
        t("settings.apps.subtitle"),
        { id: "apps/icons", build: () => AppIconsPage(nav) },
    ))
    listBox.append(navRow(
        nav,
        t("settings.autostart.title"),
        t("settings.autostart.subtitle"),
        { id: "apps/autostart", build: () => AutostartPage(nav) },
    ))

    page.append(box)
    return page
}
