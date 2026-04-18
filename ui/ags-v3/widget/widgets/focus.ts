import AstalNotifd from "gi://AstalNotifd"
import { FocusWidget } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"

function buildBarContent() {
    const notifd = AstalNotifd.get_default()
    return makeIconAction({
        getIcon: () => notifd?.dont_disturb ? "notifications-disabled-symbolic" : "notifications-symbolic",
        onAction: () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb },
        activeClass: "bar-widget-active",
        getActive: () => notifd?.dont_disturb ?? false,
    })
}

const focusWidget: AtomicWidget = {
    id: "focus",
    name: t("widget.focus.name"),
    icon: "notifications-disabled-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent: (size) => FocusWidget().buildContent(size),
    buildBarContent,
}

export default focusWidget
