import nightLight from "../core/NightLightManager"
import { RoundToggle } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"

const subscribe = (sync: () => void) => {
    const id = nightLight.connect("changed", sync)
    return () => safeDisconnect(nightLight, id)
}

function buildBarContent() {
    return makeIconAction({
        // Dedicated icon (warm sunset) — distinct from dark-mode's moon/sun. On/off
        // is conveyed by the toggle's active state, not an icon swap.
        getIcon: () => Icons.sunset,
        onAction: () => nightLight.setEnabled(!nightLight.enabled),
        subscribe,
    })
}

const nightLightWidget: AtomicWidget = {
    id: "night_light",
    category: "system",
    barOrder: 20,
    name: t("widget.night-light.name"),
    icon: Icons.sunset,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => RoundToggle(
        "night_light",
        t("widget.night-light.name"),
        () => Icons.sunset,
        () => nightLight.enabled,
        () => nightLight.setEnabled(!nightLight.enabled),
        () => nightLight.enabled
            ? `${nightLight.temperature}K`
            : t("widget.night-light.sub.off"),
        subscribe,
    ).buildContent(size, budget),
    buildBarContent,
}

export default nightLightWidget
