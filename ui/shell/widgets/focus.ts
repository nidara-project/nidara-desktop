import Gtk from "gi://Gtk?version=4.0"
import { AtomicWidget, ContentBudget, WidgetSize, makeRoundTile, makeSplitCapsuleTile, panelRow, panelSwitch, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import { dontDisturb, toggleDontDisturb, setDontDisturb, watchDnd } from "../core/NotifService"

function buildBarContent() {
    return makeBarIcon({
        getIcon: () => dontDisturb() ? uiIcon("notifications-disabled") : uiIcon("notifications"),
        onAction: toggleDontDisturb,
        activeClass: "bar-widget-active",
        getActive: dontDisturb,
    })
}

const getIcon = () => dontDisturb() ? uiIcon("notifications-disabled") : uiIcon("notifications")
const getTitle = () => dontDisturb() ? t("cc.focus.title.on") : t("cc.focus.title.off")
const getSub = () => dontDisturb() ? t("cc.focus.sub.on") : ""

// SINGLE keeps the toggle (every platform's compact quick-toggle stays a
// toggle — "open detail" is always a separate affordance, never a fallback on
// the same tap target, and there's no room for a second hit-region at 1×1).
// WIDE/SQUARE split: icon badge toggles, the rest of the capsule opens the
// detail panel — see [[project_cc_capsule_alignment]].
function buildContent(size: WidgetSize, budget: ContentBudget): Gtk.Widget {
    if (size === WidgetSize.SINGLE)
        return makeRoundTile(getIcon, dontDisturb, toggleDontDisturb, watchDnd)
    return makeSplitCapsuleTile(getIcon, getTitle, getSub, toggleDontDisturb, watchDnd, budget)
}

// ── CC detail panel: just the switch. Matches GNOME's Do Not Disturb quick
// toggle exactly — timed duration presets (1h / until evening / custom) were
// considered and deliberately left out: they need a new backend (a persisted
// "until" timestamp + auto re-enable timer), a bigger feature than a detail
// page, revisit only if the plain toggle turns out to not be enough. ──

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = panelSwitch(dontDisturb, setDontDisturb, watchDnd)

    const switchRow = panelRow(t("widget.focus.name"), sw)

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
    outer.append(switchRow)

    return outer
}

const focusWidget: AtomicWidget = {
    id: "focus",
    category: "utilities",
    barOrder: 20,
    name: t("widget.focus.name"),
    icon: uiIcon("notifications-disabled"),
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 2,
    getActive: dontDisturb,
    watchActive: watchDnd,
}

export default focusWidget
