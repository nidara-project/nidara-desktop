import { execAsync } from "ags/process"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

const launch = () => execAsync("gnome-calculator").catch(() => {})

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Icons.calculator,
        onAction: launch,
    })
}

const calculatorWidget: AtomicWidget = {
    id: "calculator",
    name: t("widget.calculator.name"),
    icon: Icons.calculator,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size) => RoundToggle(
        "calculator", t("widget.calculator.name"),
        Icons.calculator,
        false,
        launch,
    ).buildContent(size),
    buildBarContent,
}

export default calculatorWidget
