import Gtk from "gi://Gtk?version=4.0"
import { buildRoundContent, buildSplitCapsuleContent } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { dontDisturb, toggleDontDisturb, setDontDisturb, watchDnd } from "../core/NotifService"

function buildBarContent() {
    return makeIconAction({
        getIcon: () => dontDisturb() ? Icons.bellOff : Icons.bell,
        onAction: toggleDontDisturb,
        activeClass: "bar-widget-active",
        getActive: dontDisturb,
    })
}

const getIcon = () => dontDisturb() ? Icons.bellOff : Icons.bell
const getTitle = () => dontDisturb() ? t("cc.focus.title.on") : t("cc.focus.title.off")
const getSub = () => dontDisturb() ? t("cc.focus.sub.on") : ""

// SINGLE keeps the toggle (every platform's compact quick-toggle stays a
// toggle — "open detail" is always a separate affordance, never a fallback on
// the same tap target, and there's no room for a second hit-region at 1×1).
// WIDE/SQUARE split: icon badge toggles, the rest of the capsule opens the
// detail panel — see [[project_cc_capsule_alignment]].
function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE)
        return buildRoundContent(getIcon, dontDisturb, toggleDontDisturb, watchDnd)
    return buildSplitCapsuleContent(getIcon, getTitle, getSub, toggleDontDisturb, watchDnd)
}

// ── CC detail panel: just the switch. Matches GNOME's Do Not Disturb quick
// toggle exactly — timed duration presets (1h / until evening / custom) were
// considered and deliberately left out: they need a new backend (a persisted
// "until" timestamp + auto re-enable timer), a bigger feature than a detail
// page, revisit only if the plain toggle turns out to not be enough. ──

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = new Gtk.Switch({ active: dontDisturb(), valign: Gtk.Align.CENTER })
    sw.connect("state-set", (_s: Gtk.Switch, state: boolean) => { setDontDisturb(state); return false })

    const switchRow = new Gtk.Box({ spacing: 8 })
    switchRow.append(new Gtk.Label({ label: t("widget.focus.name"), css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true }))
    switchRow.append(sw)

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
    outer.append(switchRow)

    const dispose = watchDnd(() => { sw.active = dontDisturb() })
    outer.connect("unrealize", dispose)

    return outer
}

const focusWidget: AtomicWidget = {
    id: "focus",
    category: "utilities",
    barOrder: 20,
    name: t("widget.focus.name"),
    icon: Icons.bellOff,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, _budget) => buildContent(size),
    buildBarContent,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 2,
    getActive: dontDisturb,
    watchActive: watchDnd,
}

export default focusWidget
