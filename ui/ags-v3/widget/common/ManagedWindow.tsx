import { Gtk, Gdk } from "ags/gtk4"
// @ts-ignore
import Gtk4LayerShell from "gi://Gtk4LayerShell"

interface ManagedWindowProps {
    name: string
    child: Gtk.Widget
    monitor: Gdk.Monitor
    statusProp: "cc_open" | "nc_open" | "prism_open"
    layout?: {
        // @ts-ignore
        layer?: Gtk4LayerShell.Layer
        namespace?: string // 💎 Custom namespace for Hyprland rules
        anchor?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean }
        margin?: { top?: number; bottom?: number; left?: number; right?: number }
        exclusivity?: number
        width?: number
        height?: number
    }
}

/**
 * ManagedWindow - A robust LayerShell window synced with global status 🛰️
 */
export default function ManagedWindow({
    name,
    child,
    monitor,
    statusProp,
    layout = {}
}: ManagedWindowProps) {
    const win = new Gtk.Window({
        name,
        css_classes: [name, "managed-window"],
        visible: false, // 🛡️ Born hidden
    })

    win.set_decorated(false)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, layout.namespace ?? "crystal-overlay") 
        Gtk4LayerShell.set_monitor(win, monitor)
        Gtk4LayerShell.set_layer(win, layout.layer ?? Gtk4LayerShell.Layer.TOP)
        
        const anchor = layout.anchor ?? { top: true, right: true }
        if (anchor.top) Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        if (anchor.bottom) Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        if (anchor.left) Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        if (anchor.right) Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)

        const margin = layout.margin ?? { top: 40, right: 8 }
        if (margin.top) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, margin.top)
        if (margin.bottom) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, margin.bottom)
        if (margin.left) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.LEFT, margin.left)
        if (margin.right) Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, margin.right)

        // Visibility controlled externally by Overlays.tsx
        Gtk4LayerShell.set_exclusive_zone(win, layout.exclusivity ?? 0)
        
        const w = layout.width ?? -1
        const h = layout.height ?? -1
        win.set_size_request(w, h)

    } catch (e) {
        console.error(`[ManagedWindow] LayerShell fail for ${name}:`, e)
    }

    win.set_child(child)
    return win
}
