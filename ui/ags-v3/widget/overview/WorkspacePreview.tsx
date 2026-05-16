import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { createSchematicMap } from "../common/WorkspaceSchematic"

export default function WorkspacePreview(wsId: number, hyprland: any) {
    const { wrapper, sync: schematicSync } = createSchematicMap(wsId, 200, hyprland)

    const box = new Gtk.Box({
        css_classes: ["ws-preview-popover-box"],
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    })

    const title = new Gtk.Label({
        label: `Workspace ${wsId}`,
        css_classes: ["ws-preview-title"],
        halign: Gtk.Align.START,
    })

    box.append(title)
    box.append(wrapper)

    const popover = new Gtk.Popover({
        child: box,
        has_arrow: true,
        css_classes: ["ws-preview-popover"],
    })

    const sync = () => {
        if (!popover.get_visible()) return
        try {
            const monitors = hyprland.get_monitors() || []
            const workspaces = hyprland.get_workspaces() || []
            const clients = hyprland.get_clients() || []
            schematicSync(workspaces, monitors, clients)
        } catch (e) { }
    }

    popover.connect("notify::visible", () => { if (popover.get_visible()) sync() })

    const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (popover.get_visible()) sync()
        return GLib.SOURCE_CONTINUE
    })

    popover.connect("unrealize", () => GLib.source_remove(heartbeat))

    return popover
}
