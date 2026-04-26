import { Gtk } from "ags/gtk4"
import widgetConfig from "../../../core/WidgetConfig"
import ccLayout from "../../control-center/CCLayoutManager"
import registry from "../../widgets/index"
import { pageBox, pageHeader, listGroup } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"

export default function WidgetsPage(): Gtk.Widget {
    const page = pageBox("widgets-page")
    page.append(pageHeader(t("settings.widgets.page.title.widgets"), t("settings.widgets.page.subtitle.elige-donde-aparece-cada-widget-en-la-ba")))

    const group = listGroup("Widgets disponibles")

    for (const w of registry.all()) {
        const placement = widgetConfig.get(w.id)

        const box = new Gtk.Box({
            spacing: 12,
            margin_start: 16,
            margin_end: 16,
            margin_top: 10,
            margin_bottom: 10,
        })

        // Icon + name
        box.append(new Gtk.Image({
            icon_name: w.icon ?? Icons.app,
            pixel_size: 20,
            css_classes: ["sidebar-icon"],
        }))
        const label = new Gtk.Label({
            label: w.name,
            css_classes: ["settings-row-label"],
            hexpand: true,
            halign: Gtk.Align.START,
        })
        box.append(label)

        // Bar toggle (only for widgets that support bar)
        const canBar = w.locations?.includes("bar") && w.buildBarContent != null
        const barBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.CENTER, margin_end: 8 })
        const barLabel = new Gtk.Label({ label: t("settings.widgets.label.barra"), css_classes: ["settings-row-subtitle"], halign: Gtk.Align.CENTER })
        const barSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER, sensitive: canBar ?? false })
        barSwitch.set_active(placement.bar)
        barBox.append(barLabel)
        barBox.append(barSwitch)
        box.append(barBox)

        // CC toggle (only for widgets that support cc)
        const canCC = w.locations?.includes("cc") ?? false
        const ccBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.CENTER })
        const ccLabel = new Gtk.Label({ label: t("settings.widgets.label.centro"), css_classes: ["settings-row-subtitle"], halign: Gtk.Align.CENTER })
        const ccSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER, sensitive: canCC })
        ccSwitch.set_active(placement.cc)
        ccBox.append(ccLabel)
        ccBox.append(ccSwitch)
        box.append(ccBox)

        barSwitch.connect("notify::active", () => {
            widgetConfig.setBar(w.id, barSwitch.get_active())
        })

        ccSwitch.connect("notify::active", () => {
            const enabled = ccSwitch.get_active()
            widgetConfig.setCC(w.id, enabled)
            // Sync CCLayoutManager immediately
            if (enabled) ccLayout.add(w.id)
            else ccLayout.remove(w.id)
        })

        const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        row.set_child(box)
        group.listBox.append(row)
    }

    page.append(group.box)

    // Hint about CC layout ordering
    const hint = new Gtk.Label({
        label: t("settings.widgets.label.para-reordenar-los-widgets-en-el-centro-"),
        css_classes: ["settings-row-subtitle"],
        wrap: true,
        halign: Gtk.Align.START,
        margin_start: 10,
        margin_top: 8,
    })
    page.append(hint)

    return page
}
