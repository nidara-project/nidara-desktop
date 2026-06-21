import Theme from "../core/ThemeManager"
import { RoundToggle } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"

const themeSubscribe = (sync: () => void) => {
    const id = Theme.connect("changed", sync)
    return () => safeDisconnect(Theme, id)
}

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Theme.isDark ? Icons.moon : Icons.sun,
        onAction: () => Theme.setDarkMode(!Theme.isDark),
        subscribe: themeSubscribe,
    })
}

const darkModeWidget: AtomicWidget = {
    id: "dark_mode",
    category: "system",
    barOrder: 10,
    name: t("widget.dark-mode.name"),
    icon: Icons.moon,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => RoundToggle(
        "dark-mode", t("widget.dark-mode.name"),
        () => Theme.isDark ? Icons.moon : Icons.sun,
        () => Theme.isDark,
        () => Theme.setDarkMode(!Theme.isDark),
        () => Theme.isDark ? t("widget.dark-mode.sub.dark") : t("widget.dark-mode.sub.light"),
        themeSubscribe,
    ).buildContent(size, budget),
    buildBarContent,
}

export default darkModeWidget
