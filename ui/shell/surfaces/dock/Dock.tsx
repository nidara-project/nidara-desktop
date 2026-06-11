import { dockSettings } from "./state"
import DockHorizontal from "./DockHorizontal"
import DockVertical from "./DockVertical"

export default function Dock(gdkmonitor: any) {
    const pos = dockSettings.position
    const isVertical = pos === 'left' || pos === 'right'
    return isVertical ? DockVertical(gdkmonitor) : DockHorizontal(gdkmonitor)
}
