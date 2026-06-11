import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import * as BT from "../../core/BluetoothService"

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Icons.bluetooth,
        onAction: () => BT.togglePower(),
        activeClass: "bar-widget-active",
        getActive: () => BT.isPowered(),
    })
}

const btWidget: AtomicWidget = {
    id: "bt",
    name: t("widget.bluetooth.name"),
    icon: Icons.bluetooth,
    locations: ["bar", "cc"],
    isAvailable: () => BT.hasAdapter(),
    watchAvailable: (cb) => { BT.watchAdapter(cb) },
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => {
        return RoundToggle(
            "bt", t("widget.bluetooth.name"),
            Icons.bluetooth,
            () => BT.isPowered(),
            () => BT.togglePower(),
            () => BT.isPowered() ? t("widget.bluetooth.sub.active") : t("widget.bluetooth.sub.inactive"),
        ).buildContent(size, budget)
    },
    buildBarContent,
}

export default btWidget
