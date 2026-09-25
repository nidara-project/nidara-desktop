import Gtk from "gi://Gtk?version=4.0"
import status from "../../core/Status"
import { safeDisconnect } from "../../core/signals"
import { attachTooltip, type NidaraTooltipHandle, type NidaraTooltipOpts, type NidaraTooltipText } from "../../../lib/nidara-kit"

// Shared bar-capsule edge: a faint white inner border. It no longer changes on
// hover: the capsules pass `hoverLift` (the glass lifts a little) and `barOpen`
// (the glass shows the panel is open) — see GLASS_STATE_MIX. Used by Bar, Tray
// and AppTitle.
export const CAPSULE_BORDER = { r: 1, g: 1, b: 1, a: 0.2 }

// A bar capsule's height. NOT set anywhere as a size: the row is BAR_H (40) tall and
// `.bar-centerbox` gives it `margin-top: 4px`, which GTK takes out of the row's own
// height_request — so what is left for the capsule is 36. It lives here for the ones
// that must MATCH it: the island's indicator chips are this wide so that `perfect`'s
// h/2 radius makes them circles. Change the CSS margin and this together.
// (32 until 2026-09-25, with an 8px margin: always visible, unlike macOS's
// hover-only highlights, the capsules read short with that much air above them.)
export const BAR_CAPSULE_H = 36

// The gap between two bar capsules — every row of them (left, right, the widgets,
// the tray, the island's chips) and the arithmetic that decides what fits. The two
// ENDS stay at 8 (Bar.tsx BAR_MARGIN): that is Hyprland's gaps_out, so the system
// menu lines up with the windows' left edge. Tighter than the ends on purpose, so the
// row reads as one framed group. (8 until 2026-09-25; 4 lets neighbouring shadows
// fuse into one dark seam.)
export const BAR_GAP = 6

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
// `bar-overflow-open` is here only so the `»` capsule repaints as OPEN; it does not
// suppress tooltips (barPanelOpen), since the unfolded widgets are ordinary pills.
const PANEL_PROPS = ["bar-expanded-id", "cc-open", "nc-open", "system-menu-open", "prism-open", "bar-overflow-open"]

// The widget that anchors the bar's shared "custom" expansion (a tray item's menu,
// the window menu). Bar.tsx sets it; it counts only while that expansion is up.
export const CUSTOM_EXPANSION_ID = "__custom"
let customAnchor: Gtk.Widget | null = null
const anchorListeners = new Set<() => void>()
export function setBarCustomAnchor(anchor: Gtk.Widget | null) {
    if (customAnchor === anchor) return
    customAnchor = anchor
    for (const cb of anchorListeners) cb()
}
export const isBarCustomAnchor = (w: Gtk.Widget) =>
    status.bar_expanded_id === CUSTOM_EXPANSION_ID && customAnchor === w

/** SquircleContainer props that paint a bar capsule OPEN while `isOpen()` holds —
 *  the capsule stays marked for as long as the panel it opened is down. */
export function barOpen(isOpen: () => boolean) {
    return {
        getOpen: isOpen,
        watchOpen: (cb: () => void) => {
            const ids = PANEL_PROPS.map(p => status.connect(`notify::${p}`, cb))
            anchorListeners.add(cb)
            return () => {
                for (const id of ids) safeDisconnect(status, id)
                anchorListeners.delete(cb)
            }
        },
    }
}

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
