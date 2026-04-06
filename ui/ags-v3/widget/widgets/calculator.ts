import { execAsync } from "ags/process"
import { RoundToggle } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { makeIconAction } from "./bar-helpers"

const launch = () => execAsync("gnome-calculator").catch(() => {})

function buildBarContent() {
    return makeIconAction({
        getIcon: () => "accessories-calculator-symbolic",
        onAction: launch,
    })
}

const calculatorWidget: AtomicWidget = {
    id: "calculator",
    name: "Calculadora",
    icon: "accessories-calculator-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE],
    buildContent: (size) => RoundToggle(
        "calculator", "Calculadora",
        "accessories-calculator-symbolic",
        false,
        launch,
    ).buildContent(size),
    buildBarContent,
}

export default calculatorWidget
