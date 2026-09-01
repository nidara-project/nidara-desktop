import Gtk from "gi://Gtk?version=4.0"
import { listGroup, createRow, pageBox, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { SUBPAGE_BUILDERS, subpagesOf } from "../subpages"

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

    // The three rows come from the manifest, in its order: id, title and subtitle
    // are declared once and read here, rather than being written out again beside
    // the builder. A subpage that is added to the manifest appears here; one whose
    // `builder` has no entry in SUBPAGE_BUILDERS does not compile.
    for (const sub of subpagesOf("apps")) {
        const build = SUBPAGE_BUILDERS[sub.builder as keyof typeof SUBPAGE_BUILDERS]
        if (!build) continue
        listBox.append(navRow(
            nav,
            t(sub.label as any),
            t((sub.subtitle ?? "") as any),
            { id: sub.id, build: () => build(nav) },
        ))
    }

    page.append(box)
    return page
}
