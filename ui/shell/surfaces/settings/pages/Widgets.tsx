import { Gtk } from "ags/gtk4"
import widgetConfig from "../../../core/WidgetConfig"
import ccLayout from "../../control-center/CCLayoutManager"
import registry, { widgetAvailable, CATEGORY_ORDER } from "../../../widgets/index"
import { AtomicWidget, WidgetCategory } from "../../control-center/Types"
import { pageBox, listGroup, createRow, type SettingsNav } from "../SettingsHelpers"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { attachTooltip } from "../../../common/Tooltip"

// A compact labelled switch ("Bar" / "Center" + a Gtk.Switch), the unit the
// widget row places to its right. The tooltip rides the (always-sensitive) group
// box, not the switch — an insensitive switch receives no pointer events, so a
// tooltip set on it would never show the "no hardware / no space" reason.
function controlGroup(label: string, active: boolean, sensitive: boolean, tooltip: string, cb: (v: boolean) => void): Gtk.Box {
    const group = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    if (tooltip) attachTooltip(group, tooltip, { chrome: false })
    group.append(new Gtk.Label({ label, css_classes: ["nidara-row-subtitle"], valign: Gtk.Align.CENTER }))
    const sw = new Gtk.Switch({ active, sensitive, valign: Gtk.Align.CENTER })
    sw.connect("notify::active", () => cb(sw.get_active()))   // connected AFTER initial active → no spurious fire
    group.append(sw)
    return group
}

// One row per widget: leading identity icon + name, then the Bar / Control Center
// switches on the right — and NOTHING else in that trailing slot, which is what
// keeps the switch columns aligned down the whole page. A widget with its own
// settings grows a second line inside the SAME row (see the footer below).
function buildWidgetRow(nav: SettingsNav, w: AtomicWidget): Gtk.ListBoxRow {
    const placement = widgetConfig.get(w.id)
    // Hardware gate: the row stays visible (so the user sees WHY it's off) but the
    // switches render off + disabled with a hint, and the icon dims. Placement
    // config is untouched — the saved state comes back with the hardware.
    const available = widgetAvailable(w)
    const noHw = t("settings.widgets.tooltip.no-hardware")

    const leadingIcon = new Gtk.Image({
        gicon: w.icon ?? Icons.app, pixel_size: 18,
        css_classes: ["nd-icon"], valign: Gtk.Align.CENTER,
        opacity: available ? 1 : 0.5,
    })

    const controls = new Gtk.Box({ spacing: 20, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })

    // Bar switch — only for widgets that can actually render in the bar.
    if (w.locations?.includes("bar") && w.buildBarContent != null) {
        controls.append(controlGroup(
            t("settings.widgets.col.bar"), available && placement.bar, available,
            available ? "" : noHw,
            (v) => widgetConfig.setBar(w.id, v),
        ))
    }

    // Control Center switch — disabled (with a tooltip) when the hardware is
    // missing, or when the grid is full and the widget isn't already in it.
    if (w.locations?.includes("cc")) {
        const ccFits = placement.cc || ccLayout.canAdd(w.id)
        controls.append(controlGroup(
            t("settings.widgets.col.cc"), available && placement.cc, available && ccFits,
            !available ? noHw : ccFits ? "" : t("settings.widgets.tooltip.no-space"),
            (v) => {
                widgetConfig.setCC(w.id, v)
                if (v) ccLayout.add(w.id)
                else ccLayout.remove(w.id)
            },
        ))
    }

    // "Configure" goes on a SECOND LINE INSIDE this row, never in the trailing
    // slot beside the switches. Two earlier shapes were wrong, both user-caught
    // on 2026-08-02:
    //   1. A chevron appended to the trailing slot. The slot is for ONE control
    //      and it then held three — and since only SOME widgets have settings,
    //      the chevron pushed just those rows' switches left, so the Bar/Center
    //      columns stopped lining up down the page. An OPTIONAL control in the
    //      trailing slot misaligns the whole column; "it fits" is not the test.
    //   2. A sibling row underneath. That fixed the alignment but read as
    //      another ITEM in the list — an indent alone cannot say "this belongs
    //      to the row above" when every row in a list looks alike.
    // Inside the row, the two lines share one cell and one hover, so ownership
    // is structural rather than a hint.
    const footer = (w.buildSettings && available) ? configureButton(nav, w) : undefined
    return createRow(w.name, "", controls, undefined, leadingIcon, footer)
}

/** The in-row "Configure" control. Reuses the key that used to label this
 *  control's tooltip — already translated in all 12 catalogues, so moving it
 *  cost no new translation debt. */
function configureButton(nav: SettingsNav, w: AtomicWidget): Gtk.Button {
    const btn = NidaraButton({
        // ghost + compact is exactly what the size ramp documents this slot for:
        // a control inside a dense row that must not out-weigh the row's own
        // text (same call the CC audio detail's "set as default" link makes).
        // It is editorial here, not a way to make something fit.
        label: t("settings.widgets.configure"),
        variant: "ghost", size: "compact", halign: Gtk.Align.START,
    })
    // Line the LABEL up with the widget's NAME — the text is what the eye reads
    // down that column, not the button's box. Leading-icon width (18) + the row's
    // 16px spacing, MINUS the 10px left padding `.nidara-btn--compact` puts
    // inside the button (_components.scss): a ghost button has no visible edge,
    // so that padding is pure optical offset and showed up live as a 10px step
    // under the name. NidaraRow can't compute the first half — only the caller
    // knows how big its leading icon is.
    btn.margin_start = 34 - 10
    btn.connect("clicked", () => nav.pushSubpage({
        id: `widgets/${w.id}`, title: w.name, parentId: "widgets", build: w.buildSettings!,
    }))
    return btn
}

// Widgets are grouped by category (Media / Utilities / System) in the SAME order
// they appear across the bar — so Settings and the bar tell the same story. Each
// category is one inset list (NidaraList renders its uppercase title), one row per
// widget inside it.
export default function WidgetsPage(nav: SettingsNav): Gtk.Widget {
    const page = pageBox("widgets-page")

    const catLabel: Record<WidgetCategory, string> = {
        system: t("settings.widgets.category.system"),
        utilities: t("settings.widgets.category.utilities"),
        media: t("settings.widgets.category.media"),
    }

    for (const cat of CATEGORY_ORDER) {
        const widgets = registry.all()
            .filter(w => w.category === cat)
            .sort((a, b) => (a.barOrder ?? 0) - (b.barOrder ?? 0))
        if (widgets.length === 0) continue
        const { box, listBox } = listGroup(catLabel[cat])
        for (const w of widgets) listBox.append(buildWidgetRow(nav, w))
        page.append(box)
    }

    // Reordering lives in the CC's own Edit mode, not here.
    page.append(new Gtk.Label({
        label: t("settings.widgets.reorder-note"),
        css_classes: ["nidara-row-subtitle"],
        wrap: true, halign: Gtk.Align.START, margin_start: 10,
    }))

    return page
}
