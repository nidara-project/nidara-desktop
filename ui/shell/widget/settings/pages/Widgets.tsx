import { Gtk } from "ags/gtk4"
import widgetConfig from "../../../core/WidgetConfig"
import ccLayout from "../../control-center/CCLayoutManager"
import registry from "../../widgets/index"
import { AtomicWidget } from "../../control-center/Types"
import { pageBox, listGroup, createRow, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"

// A toggle row whose switch can be disabled (with a tooltip) — the generic
// toggleRow helper always builds a sensitive switch, but the CC toggle has to
// block when the grid is full (fixed-grid model — see CCLayoutManager.canAdd).
function switchRow(label: string, active: boolean, sensitive: boolean, tooltip: string, cb: (v: boolean) => void): Gtk.ListBoxRow {
    const sw = new Gtk.Switch({ active, sensitive, valign: Gtk.Align.CENTER })
    if (tooltip) sw.tooltip_text = tooltip
    sw.connect("notify::active", () => cb(sw.get_active()))   // connected AFTER the initial active → no spurious fire
    return createRow(label, "", sw)
}

// "Configure" row — only added for widgets that declare buildSettings. Pushes the
// widget's own settings page as a subpage (breadcrumb parent = the Widgets page).
function configureRow(nav: SettingsNav, w: AtomicWidget): Gtk.ListBoxRow {
    const chevron = new Gtk.Image({
        gicon: Icons.chevronRight, pixel_size: 16,
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["cs-icon"],
    })
    const row = createRow(t("settings.widgets.configure"), "", chevron)
    row.set_cursor_from_name("pointer")
    const click = new Gtk.GestureClick()
    click.connect("released", () => nav.pushSubpage({
        id: `widgets/${w.id}`, title: w.name, parentId: "widgets", build: w.buildSettings!,
    }))
    row.add_controller(click)
    return row
}

// One card per widget: an icon+name header over a boxed list of its toggles
// (Bar / Control Center) plus an optional Configure link. Replaces the old flat
// one-row-per-widget list so each widget reads as its own module (macOS-style)
// and has room to grow its own options.
export default function WidgetsPage(nav: SettingsNav): Gtk.Widget {
    const page = pageBox("widgets-page")

    for (const w of registry.all()) {
        const placement = widgetConfig.get(w.id)
        const { box, listBox } = listGroup("")

        // Identity header (icon + name) — prepended ABOVE the listBox so it doesn't
        // pick up a clickable row's hover/press state (it isn't interactive).
        const header = new Gtk.Box({ spacing: 10, margin_start: 10, margin_bottom: 2, valign: Gtk.Align.CENTER })
        header.append(new Gtk.Image({ gicon: w.icon ?? Icons.app, pixel_size: 18, css_classes: ["cs-icon"] }))
        header.append(new Gtk.Label({ label: w.name, css_classes: ["crystal-row-title"], halign: Gtk.Align.START }))
        box.prepend(header)

        // Bar toggle — only for widgets that can actually render in the bar.
        if (w.locations?.includes("bar") && w.buildBarContent != null) {
            listBox.append(switchRow(
                t("settings.widgets.show-in-bar"), placement.bar, true, "",
                (v) => widgetConfig.setBar(w.id, v),
            ))
        }

        // Control Center toggle — disabled (with a tooltip) when the grid is full
        // and the widget isn't already in it.
        if (w.locations?.includes("cc")) {
            const ccFits = placement.cc || ccLayout.canAdd(w.id)
            listBox.append(switchRow(
                t("settings.widgets.show-in-cc"), placement.cc, ccFits,
                ccFits ? "" : t("settings.widgets.tooltip.no-space"),
                (v) => {
                    widgetConfig.setCC(w.id, v)
                    if (v) ccLayout.add(w.id)
                    else ccLayout.remove(w.id)
                },
            ))
        }

        if (w.buildSettings) listBox.append(configureRow(nav, w))

        page.append(box)
    }

    // Reordering lives in the CC's own Edit mode, not here.
    page.append(new Gtk.Label({
        label: t("settings.widgets.reorder-note"),
        css_classes: ["crystal-row-subtitle"],
        wrap: true, halign: Gtk.Align.START, margin_start: 10, margin_top: 4,
    }))

    return page
}
