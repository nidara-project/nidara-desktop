import { Gtk } from "ags/gtk4"
import SquircleContainer from "../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import status from "../../core/Status"
import hs from "../../core/HyprlandState"

// Bar-center capsule with 5 workspace dots (active / occupied / empty),
// clicking it toggles the Workspace Overview.
export function Workspaces(): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16 })
  for (let i = 1; i <= 5; i++) {
    const dot = new Gtk.Box({ css_classes: ["workspace-dot"], valign: Gtk.Align.CENTER })
    const update = () => {
      const active   = hs.focusedWorkspaceId === i
      const occupied = hs.occupiedWorkspaces.has(i)
      dot.set_css_classes(["workspace-dot", active ? "active" : occupied ? "occupied" : "empty"])
    }
    hs.connect("changed", update)
    update()
    box.append(dot)
  }
  return SquircleContainer({ child: box, gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleOverview() })
}

export default Workspaces
