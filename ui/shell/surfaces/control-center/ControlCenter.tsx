import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import IslandGrid from "./IslandGrid"
import { ccStatusBanner } from "../bar/StatusIndicators"

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
    })

    // Status banner (recording / AI control) above the widgets — collapses to
    // nothing when nothing is active. The kill switch / Stop lives here.
    layout.append(ccStatusBanner())
    layout.append(IslandGrid())

    return layout
}
