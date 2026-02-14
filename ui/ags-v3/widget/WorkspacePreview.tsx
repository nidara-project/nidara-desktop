import { Gtk } from "ags/gtk4"
import { Schematic } from "./Schematic"
import GLib from "gi://GLib"

/**
 * WorkspacePreview - A subtle popover showing workspace contents 🖼️
 */
export default function WorkspacePreview(wsId: number, hyprland: any) {
    const schematic = Schematic(wsId, hyprland, 200) // Smaller for preview
    const inner = (schematic as any).schematic

    const box = new Gtk.Box({
        css_classes: ["ws-preview-popover-box"],
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        padding: 8
    })

    const title = new Gtk.Label({
        label: `Workspace ${wsId}`,
        css_classes: ["ws-preview-title"],
        halign: Gtk.Align.START
    })

    box.append(title)
    box.append(schematic)

    const popover = new Gtk.Popover({
        child: box,
        has_arrow: true,
        css_classes: ["ws-preview-popover"]
    })

    // Sync Logic 💓
    const sync = () => {
        if (!popover.get_visible()) return
        try {
            const monitors = hyprland.get_monitors() || []
            const workspaces = hyprland.get_workspaces() || []
            const clients = hyprland.get_clients() || []
            inner.sync(workspaces, monitors, clients)
        } catch (e) { }
    }

    popover.connect("notify::visible", () => {
        if (popover.get_visible()) sync()
    })

    // Optional: add a tiny heartbeat when visible
    const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (popover.get_visible()) sync()
        return GLib.SOURCE_CONTINUE
    })

    popover.connect("unrealize", () => GLib.source_remove(heartbeat))

    return popover
}
