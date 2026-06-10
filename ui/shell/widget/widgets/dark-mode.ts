import Theme from "../../core/ThemeManager"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

const themeSubscribe = (sync: () => void) => {
    const id = Theme.connect("changed", sync)
    return () => { try { Theme.disconnect(id) } catch {} }
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
    name: t("widget.dark-mode.name"),
    icon: Icons.moon,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size) => RoundToggle(
        "dark-mode", t("widget.dark-mode.name"),
        () => Theme.isDark ? Icons.moon : Icons.sun,
        () => Theme.isDark,
        () => Theme.setDarkMode(!Theme.isDark),
        () => Theme.isDark ? t("widget.dark-mode.sub.dark") : t("widget.dark-mode.sub.light"),
        themeSubscribe,
    ).buildContent(size),
    buildBarContent,
}

export default darkModeWidget
