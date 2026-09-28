import Gtk from "gi://Gtk?version=4.0"
import { AtomicWidget, ContentBudget, WidgetSize, roundToggleSpec, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import { dontDisturb, toggleDontDisturb, watchDnd } from "../core/NotifService"

function buildBarContent() {
    return makeBarIcon({
        getIcon: () => dontDisturb() ? uiIcon("nd-notifications-disabled") : uiIcon("nd-notifications"),
        onAction: toggleDontDisturb,
        activeClass: "bar-widget-active",
        getActive: dontDisturb,
    })
}

const getIcon = () => dontDisturb() ? uiIcon("nd-notifications-disabled") : uiIcon("nd-notifications")
const getTitle = () => dontDisturb() ? t("cc.focus.title.on") : t("cc.focus.title.off")
const getSub = () => dontDisturb() ? t("cc.focus.sub.on") : ""

// No detail panel: all it ever held was the switch, the same one-tap the tile is, and
// once the CC put a detail's master switch on its title line (contract.ts
// `ccDetailSwitch`) it would have been a title and nothing under it. So the whole tile
// is the toggle, at every size, as Appearance's. Timed presets (1 h / until evening)
// were considered and left out: they need a persisted "until" and a timer — revisit if
// the plain toggle is not enough; they are what would bring a detail back.
const buildContent = (size: WidgetSize, budget: ContentBudget): Gtk.Widget => roundToggleSpec(
    "focus", t("widget.focus.name"), getIcon, dontDisturb, toggleDontDisturb, getSub, watchDnd, getTitle,
).buildContent(size, budget)

const focusWidget: AtomicWidget = {
    id: "focus",
    category: "utilities",
    barOrder: 20,
    name: t("widget.focus.name"),
    icon: uiIcon("nd-notifications-disabled"),
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    getActive: dontDisturb,
    watchActive: watchDnd,
    // Active = Do Not Disturb on. Fixed in the CC, so "When active" can be offered:
    // the CC tile is where it is turned back on (contract.ts `barActive`).
    defaultInBar: true,
    ccFixed: true,
    barActive: dontDisturb,
    watchBarActive: watchDnd,
    defaultBarMode: "active",
}

export default focusWidget
