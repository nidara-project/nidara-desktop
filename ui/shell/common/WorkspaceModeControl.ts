import Gtk from "gi://Gtk?version=4.0"
import Icons from "../core/Icons"
import { menuRow } from "./MenuRow"
import { t } from "../core/i18n"
import workspaceModes, { WORKSPACE_MODES, type WorkspaceMode } from "../core/WorkspaceModes"

/**
 * The workspace mode (#513), as one control with two faces.
 *
 * 🔑 It is ONE module on purpose. The mode lives in two surfaces because they
 * answer different questions — the overview is the only place you see the five
 * workspaces at once, so that is where the mode is READ; the window menu acts on
 * the one you are standing in without leaving it — and two surfaces drawing the
 * same state from two copies of the vocabulary is how they come to disagree about
 * what "tiling" looks like.
 *
 * The pairing: `grid` for tiling (windows share the space), `app-window` for
 * floating (one window, free). Both are already in our icon set; neither is an
 * emoji and neither is a hardcoded colour — commandment 10.
 */
export const modeIcon = (mode: WorkspaceMode) => (mode === "tiling" ? Icons.grid : Icons.app)

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
        // the tooltip is the answer, and the window menu spells it out in full.
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

/**
 * The window menu's rows for the workspace you are on: one per mode, with the
 * current one checked. A pair of checked rows rather than a single toggle,
 * because a menu that says "Tiling" cannot tell you what it is going to do — set
 * it, or say it already is.
 */
export function workspaceModeRows(wsId: number, onDone: () => void): Gtk.Widget[] {
    const current = workspaceModes.getEffectiveMode(wsId)
    return WORKSPACE_MODES.map((mode) =>
        menuRow({
            label: modeLabel(mode),
            icon: modeIcon(mode),
            checked: mode === current,
            ellipsize: true,
            onClick: () => {
                // Setting the mode a workspace already has is a no-op in the
                // service, so the checked row stays a statement rather than
                // becoming a second way to re-tile everything by accident.
                void workspaceModes.setWorkspaceMode(wsId, mode)
                onDone()
            },
        }),
    )
}
