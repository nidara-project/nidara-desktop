import nightLight from "../../core/NightLightManager"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

const subscribe = (sync: () => void) => {
    const id = nightLight.connect("changed", sync)
    return () => { try { nightLight.disconnect(id) } catch {} }
}

function buildBarContent() {
    return makeIconAction({
        getIcon: () => nightLight.enabled ? Icons.moon : Icons.sun,
        onAction: () => nightLight.setEnabled(!nightLight.enabled),
        subscribe,
    })
}

const nightLightWidget: AtomicWidget = {
    id: "night_light",
    name: t("widget.night-light.name"),
    icon: Icons.moon,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent: (size) => RoundToggle(
        "night_light",
        t("widget.night-light.name"),
        () => nightLight.enabled ? Icons.moon : Icons.sun,
        () => nightLight.enabled,
        () => nightLight.setEnabled(!nightLight.enabled),
        () => nightLight.enabled
            ? `${nightLight.temperature}K`
            : t("widget.night-light.sub.off"),
        subscribe,
    ).buildContent(size),
    buildBarContent,
}

export default nightLightWidget
