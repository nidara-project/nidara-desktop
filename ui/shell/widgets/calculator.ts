import { execAsync } from "../../lib/process"
import { AtomicWidget, WidgetSize, roundToggleSpec } from "../common/widget-kit"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

const launch = () => execAsync("gnome-calculator").catch(() => {})

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Icons.calculator,
        onAction: launch,
    })
}

const calculatorWidget: AtomicWidget = {
    id: "calculator",
    category: "utilities",
    barOrder: 30,
    name: t("widget.calculator.name"),
    icon: Icons.calculator,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => roundToggleSpec(
        "calculator", t("widget.calculator.name"),
        Icons.calculator,
        false,
        launch,
    ).buildContent(size, budget),
    buildBarContent,
}

export default calculatorWidget
