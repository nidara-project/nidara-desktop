import Gtk from "gi://Gtk?version=4.0"
import { uiIcon } from "../core/Icons"
import { t } from "../core/i18n"
import workspaceModes, { type WorkspaceMode } from "../core/WorkspaceModes"

/**
 * The workspace mode (#513): its vocabulary, and the overview's badge.
 *
 * 🔑 The mode belongs to the DESKTOP, so it lives where the desktops are: the overview
 * the dots open, one badge per desktop, and Settings. It used to be in the bar's window
 * menu too, and left it when that menu became the app's (2026-10-05): a menu that hangs
 * from an app's name is no place to re-tile a whole desktop. This module stays the one
 * copy of the words and icons, so Settings and the overview cannot disagree about what
 * "tiling" looks like.
 *
 * The pairing: `grid` for tiling (windows share the space), `app-window` for
 * floating (one window, free). Both are already in our icon set; neither is an
 * emoji and neither is a hardcoded colour — commandment 10.
 */
export const modeIcon = (mode: WorkspaceMode) => (mode === "tiling" ? uiIcon("nd-window-tiling") : uiIcon("nd-window-floating"))

export const modeLabel = (mode: WorkspaceMode) =>
    t(mode === "tiling" ? "workspace.mode.tiling" : "workspace.mode.floating")

/**
 * The overview card's badge: shows the workspace's mode and flips it on click.
 *
 * ⚠️ It lives INSIDE the card's `Gtk.Button`, so its gesture runs in the CAPTURE
 * phase and CLAIMS the sequence. Without that the card's own click wins and the
 * badge silently switches workspace instead of switching mode — a button inside a
 * button is not a hierarchy GTK4 resolves for you.
 *
 * Long-lived widget: the "changed" subscription is never disconnected, the same
 * lifetime model as the workspace dots it sits next to (`WorkspaceDot.ts`).
 */
export function makeWorkspaceModeBadge(wsId: number): Gtk.Widget {
    const image = new Gtk.Image({ pixel_size: 12, css_classes: ["nd-icon"] })
    const badge = new Gtk.Box({
        css_classes: ["wo-mode-badge"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    badge.append(image)

    const update = () => {
        const mode = workspaceModes.getEffectiveMode(wsId)
        image.gicon = modeIcon(mode)
        badge.set_css_classes(["wo-mode-badge", mode])
        // The words live here rather than on the badge: the icon is the glance,
        // the tooltip is the answer, and Settings spells it out in full.
        badge.tooltip_text = modeLabel(mode)
    }

    const click = new Gtk.GestureClick()
    click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    click.connect("pressed", (gesture) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        void workspaceModes.toggleWorkspaceMode(wsId)
    })
    badge.add_controller(click)

    workspaceModes.connect("changed", update)
    update()
    return badge
}
