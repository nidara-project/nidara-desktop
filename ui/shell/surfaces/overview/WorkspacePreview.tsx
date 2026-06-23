import { Gtk } from "ags/gtk4"
import { createSchematicMap } from "../../common/WorkspaceSchematic"
import hs from "../../core/HyprlandState"
import { safeDisconnect } from "../../core/signals"

export default function WorkspacePreview(wsId: number) {
    const { wrapper, sync: schematicSync } = createSchematicMap(wsId, 200)

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

    const changedId = hs.connect("changed", () => {
        if (popover.get_visible()) schematicSync()
    })

    popover.connect("notify::visible", () => { if (popover.get_visible()) schematicSync() })
    popover.connect("unrealize", () => safeDisconnect(hs, changedId))

    return popover
}
