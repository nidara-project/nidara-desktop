import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import IslandGrid from "./IslandGrid"

export function ControlCenterWidget(monitor: Gdk.Monitor) {
    const layout = new Gtk.Box({
        name: "cc-layout-root",
        // .overlay-fade: shared opacity crossfade. Visibility + the .overlay-open
        // toggle are driven by the bar's setCCVisible() (so the deferred-hide can
        // refresh the input region after the fade-out). Starts hidden.
        css_classes: ["cc-window-root", "overlay-fade"],
        visible: false,
        hexpand: false,
        vexpand: true,
        halign: Gtk.Align.END,
        valign: Gtk.Align.FILL,
    })

    layout.append(IslandGrid())

    return layout
}
