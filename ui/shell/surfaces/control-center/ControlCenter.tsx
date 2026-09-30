import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import IslandGrid from "./IslandGrid"
import { ccStatusBanner } from "../bar/StatusIndicators"

/**
 * The CC is a PANEL (owner, 2026-09-30): its content sits inside a
 * margin, as it would in a window, though nothing draws the panel today — under
 * Increase contrast it will be (#674), and its spacing has to be a panel's already.
 * The margin is 16 on every side (owner, 2026-09-30: "if the container were solid it
 * would have to be a panel, and a panel cannot have its content stuck to its top
 * edge") — from the panel's edge to the first thing in it, the privacy notice or a
 * tile. It equals the gap between tiles (CCLayoutManager GAP, also 16), so edge-to-tile
 * reads like tile-to-tile. The panel itself hangs `BAR_MARGIN` (= `gaps_out`) below the bar and from the
 * screen's edge, as a window would (Bar.tsx places it).
 */
export const CC_PANEL_PAD = 16

export function ControlCenterWidget(monitor: Gdk.Monitor) {
    const layout = new Gtk.Box({
        name: "cc-layout-root",
        // Visibility + the pop animation are owned by the bar's ScaleRevealer
        // wrapper (setCCVisible), which refreshes the input region after closing.
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["cc-window-root"],
        hexpand: false,
        vexpand: true,
        halign: Gtk.Align.END,
        valign: Gtk.Align.FILL,
        margin_top: CC_PANEL_PAD, margin_bottom: CC_PANEL_PAD,
        margin_start: CC_PANEL_PAD, margin_end: CC_PANEL_PAD,
    })

    // Status banner (recording / AI control) above the widgets — collapses to
    // nothing when nothing is active. The kill switch / Stop lives here.
    layout.append(ccStatusBanner())
    layout.append(IslandGrid())

    // No container under the tiles: the halo that stood there (2026-09-29/30) read as a
    // ghost panel and was removed by the owner. The panel itself is for Increase
    // contrast (#674).
    return layout
}
