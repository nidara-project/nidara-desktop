import Theme from "../../core/ThemeManager"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Theme.isDark ? "weather-clear-night-symbolic" : "weather-clear-symbolic",
        onAction: () => Theme.setDarkMode(!Theme.isDark),
    })
}

const darkModeWidget: AtomicWidget = {
    id: "dark_mode",
    name: "Apariencia",
    icon: "weather-clear-night-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent: (size) => RoundToggle(
        "dark-mode", "Apariencia",
        () => Theme.isDark ? "weather-clear-night-symbolic" : "weather-clear-symbolic",
        () => Theme.isDark,
        () => Theme.setDarkMode(!Theme.isDark),
        () => Theme.isDark ? "Oscuro" : "Claro",
    ).buildContent(size),
    buildBarContent,
}

export default darkModeWidget
