import AstalNotifd from "gi://AstalNotifd"
import { FocusWidget } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

function buildBarContent() {
    const notifd = AstalNotifd.get_default()
    return makeIconAction({
        getIcon: () => notifd?.dont_disturb ? Icons.bellOff : Icons.bell,
        onAction: () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb },
        activeClass: "bar-widget-active",
        getActive: () => notifd?.dont_disturb ?? false,
    })
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
    buildContent: (size, budget) => FocusWidget().buildContent(size, budget),
    buildBarContent,
}

export default focusWidget
