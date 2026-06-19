import { Gtk } from "ags/gtk4"
import widgetConfig from "../../../core/WidgetConfig"
import ccLayout from "../../control-center/CCLayoutManager"
import registry, { widgetAvailable, CATEGORY_ORDER } from "../../../widgets/index"
import { AtomicWidget, WidgetCategory } from "../../control-center/Types"
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
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
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
// (Bar / Control Center) plus an optional Configure link. Each widget reads as its
// own module (macOS-style) and has room to grow its own options.
function buildWidgetCard(nav: SettingsNav, w: AtomicWidget): Gtk.Widget {
    const placement = widgetConfig.get(w.id)
    // Hardware gate: card stays visible (so the user sees WHY it's off) but
    // both toggles render off + disabled with a hint. Placement config is
    // untouched — the saved state comes back with the hardware.
    const available = widgetAvailable(w)
    const noHw = t("settings.widgets.tooltip.no-hardware")
    const { box, listBox } = listGroup("")

    // Identity header (icon + name) — prepended ABOVE the listBox so it doesn't
    // pick up a clickable row's hover/press state (it isn't interactive).
    const header = new Gtk.Box({ spacing: 10, margin_start: 10, margin_bottom: 2, valign: Gtk.Align.CENTER })
    header.append(new Gtk.Image({ gicon: w.icon ?? Icons.app, pixel_size: 18, css_classes: ["nd-icon"], opacity: available ? 1 : 0.5 }))
    header.append(new Gtk.Label({ label: w.name, css_classes: ["nidara-row-title"], halign: Gtk.Align.START, opacity: available ? 1 : 0.5 }))
    box.prepend(header)

    // Bar toggle — only for widgets that can actually render in the bar.
    if (w.locations?.includes("bar") && w.buildBarContent != null) {
        listBox.append(switchRow(
            t("settings.widgets.show-in-bar"), available && placement.bar, available,
            available ? "" : noHw,
            (v) => widgetConfig.setBar(w.id, v),
        ))
    }

    // Control Center toggle — disabled (with a tooltip) when the hardware is
    // missing, or when the grid is full and the widget isn't already in it.
    if (w.locations?.includes("cc")) {
        const ccFits = placement.cc || ccLayout.canAdd(w.id)
        listBox.append(switchRow(
            t("settings.widgets.show-in-cc"), available && placement.cc, available && ccFits,
            !available ? noHw : ccFits ? "" : t("settings.widgets.tooltip.no-space"),
            (v) => {
                widgetConfig.setCC(w.id, v)
                if (v) ccLayout.add(w.id)
                else ccLayout.remove(w.id)
            },
        ))
    }

    if (w.buildSettings && available) listBox.append(configureRow(nav, w))

    return box
}

// Section header above each category cluster — same look as the listGroup titles
// used elsewhere in Settings (uppercase, dim).
function categoryHeader(label: string, first: boolean): Gtk.Widget {
    return new Gtk.Label({
        label: label.toUpperCase(),
        css_classes: ["nidara-list-title"],
        halign: Gtk.Align.START,
        margin_top: first ? 0 : 10,
    })
}

// Widgets are grouped by category (Media / Utilities / System) in the SAME order
// they appear across the bar — so Settings and the bar tell the same story. The
// flat one-card-per-widget list is preserved within each group.
export default function WidgetsPage(nav: SettingsNav): Gtk.Widget {
    const page = pageBox("widgets-page")

    const catLabel: Record<WidgetCategory, string> = {
        system: t("settings.widgets.category.system"),
        utilities: t("settings.widgets.category.utilities"),
        media: t("settings.widgets.category.media"),
    }

    let first = true
    for (const cat of CATEGORY_ORDER) {
        const widgets = registry.all()
            .filter(w => w.category === cat)
            .sort((a, b) => (a.barOrder ?? 0) - (b.barOrder ?? 0))
        if (widgets.length === 0) continue
        page.append(categoryHeader(catLabel[cat], first))
        first = false
        for (const w of widgets) page.append(buildWidgetCard(nav, w))
    }

    // Reordering lives in the CC's own Edit mode, not here.
    page.append(new Gtk.Label({
        label: t("settings.widgets.reorder-note"),
        css_classes: ["nidara-row-subtitle"],
        wrap: true, halign: Gtk.Align.START, margin_start: 10, margin_top: 4,
    }))

    return page
}
