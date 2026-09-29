import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import IslandGrid from "./IslandGrid"
import { ccStatusBanner } from "../bar/StatusIndicators"
import { GlassHalo } from "../../common/GlassHalo"
import { BAR_MARGIN } from "../bar/capsule"

/**
 * The CC is a PANEL (owner, 2026-09-30, after macOS 27's): its content sits inside a
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

/** How far the CC's halo reaches past the panel: only down to the bar above (it
 *  must not darken the bar's capsules), 24 at the sides, 32 below — light from above.
 *  Bar.tsx widens the visible region by it: outside that the compositor draws nothing. */
export const CC_HALO_OUTSET = { top: BAR_MARGIN, right: 24, bottom: 32, left: 24 } as const

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

    // The container under the tiles (#673): a soft shadow that is also the surface's
    // first step of thickening — `common/GlassHalo.ts`.
    return new GlassHalo(layout, { inset: CC_PANEL_PAD, outset: CC_HALO_OUTSET })
}
