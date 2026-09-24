import Gtk from "gi://Gtk?version=4.0"
import status from "../../core/Status"
import { attachTooltip, type NidaraTooltipHandle, type NidaraTooltipOpts, type NidaraTooltipText } from "../../../lib/nidara-kit"

// Shared bar-capsule edge: a faint white inner border at rest. On hover the
// capsules pass hoverBorderAccent, which repaints this border with the current
// accent at full opacity. Used by Bar, Workspaces and AppTitle.
export const CAPSULE_BORDER = { r: 1, g: 1, b: 1, a: 0.2 }

// Whether a panel that drops from the bar is open — its own expansion panel (a
// widget's, a tray menu), or the CC / NC / system menu, which all sit under the
// bar's right and left ends.
export const barPanelOpen = () =>
    status.bar_expanded_id !== "" || status.cc_open || status.nc_open || status.system_menu_open

// The bar's tooltip: the kit's, plus the dock's rule — none while a panel is open,
// and one already showing goes away the moment a panel opens. In the dock that second
// half is free: its menu is a popover with its own grab, so the pointer LEAVES the
// icon and the tooltip closes on leave. A bar panel is drawn in the bar's own surface,
// so the pointer never leaves the capsule it just clicked and the bubble stayed over
// the panel. Here "a panel is open" is Status state, so that is what closes it.
const openTips = new Set<NidaraTooltipHandle>()
const closeAll = () => { if (barPanelOpen()) for (const tip of openTips) tip.popover.popdown() }
for (const prop of ["bar-expanded-id", "cc-open", "nc-open", "system-menu-open"])
    status.connect(`notify::${prop}`, closeAll)

export function barTooltip(widget: Gtk.Widget, text: NidaraTooltipText, opts: NidaraTooltipOpts = {}) {
    const tip = attachTooltip(widget, text, { position: Gtk.PositionType.BOTTOM, ...opts, suppress: barPanelOpen })
    openTips.add(tip)
    widget.connect("destroy", () => openTips.delete(tip))
    return tip
}
