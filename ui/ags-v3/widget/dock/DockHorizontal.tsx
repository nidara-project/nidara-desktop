import DockCore from "./DockCore"
import { horizontalAxis } from "./DockAxis"

// Bottom dock — thin wrapper; all logic lives in DockCore + the horizontal axis adapter.
export default function DockHorizontal(gdkmonitor: any) {
    return DockCore(gdkmonitor, horizontalAxis(gdkmonitor))
}
