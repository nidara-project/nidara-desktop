import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import IslandGrid from "./IslandGrid"

/**
 * 🛰️ Control Center Layer v31 💎
 * Reconstructed as a first-class shell surface, mirroring the Dock/Bar pattern.
 */
export function ControlCenterWidget(monitor: Gdk.Monitor) {
    const layout = new Gtk.Box({
        name: "cc-layout-root",
        css_classes: ["cc-window-root"],
        hexpand: false,
        vexpand: true,
        halign: Gtk.Align.END,
        valign: Gtk.Align.FILL,
        margin_top: 0, // Managed by Bar
        margin_end: 0,
    })

    layout.append(IslandGrid())

    const sync = () => {
        layout.set_visible(status.cc_open)
    }
    status.connect("notify::cc-open", sync)
    sync()
    return layout
}
