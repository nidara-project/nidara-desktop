import Theme from "../core/ThemeManager"
import { AtomicWidget, WidgetSize, roundToggleSpec, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import { safeDisconnect } from "../core/signals"

const themeSubscribe = (sync: () => void) => {
    const id = Theme.connect("changed", sync)
    return () => safeDisconnect(Theme, id)
}

// A moon for dark, a sun for light — by the names that MEAN that. This used to ask
// for `system-suspend` and `display-brightness`: the first is the "suspend the
// computer" action, which Nidara's own drawing and Adwaita happen to draw as a moon
// and Papirus, Qogir or Colloid draw as a power/sleep button; the second is the
// brightness control's. `weather-clear(-night)` is in every theme measured (#587).
const darkModeIcon = () => Theme.isDark ? uiIcon("weather-clear-night") : uiIcon("weather-clear")

function buildBarContent() {
    return makeBarIcon({
        getIcon: () => darkModeIcon(),
        onAction: () => Theme.setDarkMode(!Theme.isDark),
        subscribe: themeSubscribe,
    })
}

const darkModeWidget: AtomicWidget = {
    id: "dark_mode",
    category: "system",
    barOrder: 10,
    name: t("widget.dark-mode.name"),
    icon: uiIcon("weather-clear-night"),
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => roundToggleSpec(
        "dark-mode", t("widget.dark-mode.name"),
        () => darkModeIcon(),
        () => Theme.isDark,
        () => Theme.setDarkMode(!Theme.isDark),
        () => Theme.isDark ? t("widget.dark-mode.sub.dark") : t("widget.dark-mode.sub.light"),
        themeSubscribe,
    ).buildContent(size, budget),
    buildBarContent,
    getActive: () => Theme.isDark,
    watchActive: themeSubscribe,
}

export default darkModeWidget
