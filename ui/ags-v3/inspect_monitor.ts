
import AstalHyprland from "gi://AstalHyprland"
import { Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"

const hypr = AstalHyprland.get_default()
const display = Gdk.Display.get_default()
const monitors = display?.get_monitors()

console.log("--- GEOMETRY PROBE ---")
if (monitors) {
    for (let i = 0; i < monitors.get_n_items(); i++) {
        const gdkMon = monitors.get_item(i) as Gdk.Monitor
        const geo = gdkMon.get_geometry()
        const hyprMon = hypr.get_monitors().find(m => m.x === geo.x && m.y === geo.y)

        console.log(`Monitor ${i}:`)
        console.log(`  GDK: ${geo.width}x${geo.height} at ${geo.x},${geo.y}`)
        if (hyprMon) {
            console.log(`  Astal: ${hyprMon.width}x${hyprMon.height} at ${hyprMon.x},${hyprMon.y}`)
            console.log(`  Reserved: L=${(hyprMon as any).reserved_left}, T=${(hyprMon as any).reserved_top}, R=${(hyprMon as any).reserved_right}, B=${(hyprMon as any).reserved_bottom}`)
        } else {
            console.log("  Astal: Not found matching GDK coordinates")
        }
    }
}
