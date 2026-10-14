import { runSettingsAction } from "../SettingsErrors"
import { widgetSettingsPage } from "../widgetSettings"
import Gtk from "gi://Gtk?version=4.0"
import { widgetCatalog, type WidgetCatalogEntry } from "../../../core/WidgetCatalog"
import { CATEGORY_ORDER, type WidgetCategory } from "../../../common/widget-kit/contract"
import { pageBox, listGroup, createRow, bindWhileRealized, type SettingsNav } from "../SettingsHelpers"
import { NidaraButton, attachTooltip } from "../../../../lib/nidara-kit"
import { t } from "../../../core/i18n"
import { uiIcon, currentUiIcon } from "../../../core/Icons"

// One row per widget: leading identity icon + name, then the Bar / Control Center
// switches on the right — and NOTHING else in that trailing slot, which is what
// keeps the switch columns aligned down the whole page. A widget with its own
// settings grows a second line inside the SAME row (see the footer below).
function buildWidgetRow(nav: SettingsNav, w: WidgetCatalogEntry): Gtk.ListBoxRow {
    // Hardware gate: the row stays visible (so the user sees WHY it's off) but the
    // switches render off + disabled with a hint, and the icon dims. Placement
    // config is untouched — the saved state comes back with the hardware.
    let available = w.available
    const noHw = t("settings.widgets.tooltip.no-hardware")

    const leadingIcon = new Gtk.Image({
        gicon: currentUiIcon(w.icon) ?? uiIcon("nd-window-floating"), pixel_size: 18,
        css_classes: ["nd-icon"], valign: Gtk.Align.CENTER,
        opacity: available ? 1 : 0.5,
    })

    const controls = new Gtk.Box({ spacing: 20, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })

    // Control Center switch — disabled (with a tooltip) when the hardware is
    // missing, when the grid is full and the widget isn't already in it, or when
    // the widget is one the CC always has (on, and it stays on).
    if (w.canCc) {
        let syncing = false
        let tooltip = ""
        const group = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
        group.append(new Gtk.Label({ label: t("settings.widgets.col.cc"), css_classes: ["nidara-row-subtitle"] }))
        const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER })
        sw.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.widgets.col.cc")])
        group.append(sw)
        attachTooltip(group, () => tooltip, { chrome: false })
        const sync = () => {
            const current = widgetCatalog().list().find(entry => entry.id === w.id)
            const connected = widgetCatalog().connected !== false
            syncing = true
            available = current?.available ?? false
            sw.active = available && (current?.cc ?? false)
            sw.sensitive = connected && available && !!current?.ccFits && !current.ccFixed
            leadingIcon.opacity = available ? 1 : 0.5
            tooltip = !available ? noHw : current?.ccFixed ? t("settings.widgets.tooltip.cc-fixed")
                : current?.ccFits ? "" : t("settings.widgets.tooltip.no-space")
            syncing = false
        }
        sync()
        sw.connect("notify::active", () => {
            if (!syncing) void runSettingsAction(() => widgetCatalog().setCc(w.id, sw.active)).then(sync)
        })
        bindWhileRealized(group, () => { sync(); return widgetCatalog().watch?.(sync) })
        controls.append(group)
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
    const footer = (widgetSettingsPage(w.id) && available) ? configureButton(nav, w) : undefined
    return createRow(w.name, "", controls, undefined, leadingIcon, footer)
}

/** The in-row "Configure" control. Reuses the key that used to label this
 *  control's tooltip — already translated in all 12 catalogues, so moving it
 *  cost no new translation debt. */
function configureButton(nav: SettingsNav, w: WidgetCatalogEntry): Gtk.Button {
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
        id: `widgets/${w.id}`, title: w.name, parentId: "widgets", build: widgetSettingsPage(w.id)!,
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

    let signature = ""
    const render = () => {
        const all = widgetCatalog().list().filter(w => w.canCc)
        const next = JSON.stringify(all.map(w => [w.id, w.category, w.barOrder]))
        if (signature === next) return
        signature = next
        let child = page.get_first_child()
        while (child) { const following = child.get_next_sibling(); page.remove(child); child = following }
        if (widgetCatalog().connected === false) {
            page.append(new Gtk.Label({ label: t("settings.page.load-error"), css_classes: ["settings-placeholder"] }))
            return
        }
        const groups = CATEGORY_ORDER.map(cat => ({ cat, widgets: all.filter(w => w.category === cat)
            .sort((a, b) => a.barOrder - b.barOrder) })).filter(g => g.widgets.length)
        groups.forEach(({ cat, widgets }, i) => {
            const { box, listBox } = listGroup(catLabel[cat], i === groups.length - 1 ? t("settings.widgets.reorder-note") : "")
            for (const w of widgets) listBox.append(buildWidgetRow(nav, w))
            page.append(box)
        })
    }
    render()
    bindWhileRealized(page, () => { signature = ""; render(); return widgetCatalog().watch?.(render) })
    return page
}
