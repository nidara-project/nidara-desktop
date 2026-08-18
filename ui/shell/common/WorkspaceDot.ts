import Gtk from "gi://Gtk?version=4.0"
import hs from "../core/HyprlandState"

// Canonical workspace count (bar capsule dots, overview cards, morph ghosts).
export const WS_COUNT = 5

// One workspace state dot (active pill / occupied / empty), self-syncing from
// HyprlandState. Shared by the bar's Workspaces capsule, the overview card
// headers and the MorphRevealer's traveling ghosts — all three MUST render
// identically (same `.workspace-dot` CSS classes), because the capsule→island
// morph swaps between them at its endpoints and any visual difference reads
// as a pop. Long-lived widgets only: the "changed" subscription is never
// disconnected (same lifetime model as the bar capsule's original dots).
/** The ACTIVE dot's form, frozen and stateless — the workspaces' glyph in the
 *  island's indicator row. It says "you are on a workspace", not WHICH one: one
 *  pill cannot carry five, and the row's job is only to point back at a surface
 *  you can open. Same `.workspace-dot.active` classes as the real dots, so it is
 *  the same ink (and the only accent in the row — which is exactly what the
 *  accent is for: active state). */
export function makeActiveDotGlyph(): Gtk.Widget {
    return new Gtk.Box({
        css_classes: ["workspace-dot", "active"],
        valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER,
    })
}

export function makeWorkspaceDot(i: number): Gtk.Widget {
    const dot = new Gtk.Box({ css_classes: ["workspace-dot"], valign: Gtk.Align.CENTER })
    const update = () => {
        const active = hs.focusedWorkspaceId === i
        const occupied = hs.occupiedWorkspaces.has(i)
        dot.set_css_classes(["workspace-dot", active ? "active" : occupied ? "occupied" : "empty"])
    }
    hs.connect("changed", update)
    update()
    return dot
}
