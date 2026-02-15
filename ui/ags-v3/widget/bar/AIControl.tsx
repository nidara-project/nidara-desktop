import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"

/**
 * AIControl - Local AI Interface for DistroIA 💎
 */
export default function AIControl(monitor: Gdk.Monitor) {
    const box = new Gtk.Box({
        name: "ai-control-pill",
        css_classes: ["ai-control-pill"],
        spacing: 8,
    })

    const icon = new Gtk.Label({
        label: "💎",
        css_classes: ["ai-icon"],
    })

    const label = new Gtk.Label({
        label: "Poppi",
        css_classes: ["ai-label"],
    })

    const btn = new Gtk.Button({
        css_classes: ["ai-control-btn"],
        child: box,
    })

    box.append(icon)
    box.append(label)

    // AI Response Window (Glassmorphic Popup)
    const popup = new Gtk.Window({
        name: "ai-popup",
        css_classes: ["ai-popup", "glass"],
        visible: false,
    })

    // Add logic to toggle popup and handle Ollama requests here...
    
    btn.connect("clicked", () => {
        // Toggle AI Interface
        console.log("[AI] Toggle interface")
    })

    return btn
}
