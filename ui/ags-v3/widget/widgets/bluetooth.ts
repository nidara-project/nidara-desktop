import AstalBluetooth from "gi://AstalBluetooth"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"

function buildBarContent() {
    const bt = AstalBluetooth.get_default()
    return makeIconAction({
        getIcon: () => bt?.is_powered ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic",
        onAction: () => { if (bt) bt.is_powered = !bt.is_powered },
        activeClass: "bar-widget-active",
        getActive: () => bt?.is_powered ?? false,
    })
}

const btWidget: AtomicWidget = {
    id: "bt",
    name: t("widget.bluetooth.name"),
    icon: "bluetooth-active-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent: (size) => {
        const bt = AstalBluetooth.get_default()
        return RoundToggle(
            "bt", t("widget.bluetooth.name"),
            "bluetooth-active-symbolic",
            () => bt?.is_powered ?? false,
            () => { if (bt) bt.is_powered = !bt.is_powered },
            () => bt?.is_powered ? t("widget.bluetooth.sub.active") : t("widget.bluetooth.sub.inactive"),
        ).buildContent(size)
    },
    buildBarContent,
}

export default btWidget
