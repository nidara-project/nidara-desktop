import DockCore from "./DockCore"
import { verticalAxis } from "./DockAxis"

// Left/right dock — thin wrapper; all logic lives in DockCore + the vertical axis adapter.
export default function DockVertical(gdkmonitor: any) {
    return DockCore(gdkmonitor, verticalAxis(gdkmonitor))
}
