// SPDX-License-Identifier: LGPL-3.0-or-later
import Gtk from "gi://Gtk?version=4.0"
import { NidaraButton } from "./button"

/** One response button of a dialog. */
export interface DialogResponse {
    id: string
    label: string
    /** Danger styling — for the action that destroys or discards. */
    destructive?: boolean
    /** The default action — accent fill. At most one per dialog. */
    suggested?: boolean
    sensitive?: boolean
}

/**
 * The response row every kit dialog ends with — `showNidaraAlert` and
 * `showNidaraFormDialog` both, so the two cannot grow apart again.
 *
 * Built from `NidaraButton`, the button the rest of the desktop uses (48 call sites
 * in 2026-09): the default action is `primary` (accent), a destructive one `danger`,
 * the rest `secondary`. Equal widths (`homogeneous`), because a dialog's choices are
 * peers and the label length should not make one look more important.
 *
 * Until 2026-09-13 the dialogs had their own button: flat, full-bleed text cells
 * split by a hairline, the bottom corners rounded to the dialog — a macOS-alert idiom
 * no other surface used. Reported by the maintainer on the first live consent prompt:
 * "we are not using that format anywhere else".
 */
export function dialogButtonRow(
    responses: DialogResponse[],
    onClick: (id: string) => void,
): { box: Gtk.Box; buttons: Map<string, Gtk.Button> } {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        homogeneous: true,
        spacing: 8,
        css_classes: ["nidara-dialog-buttons"],
    })
    const buttons = new Map<string, Gtk.Button>()
    for (const resp of responses) {
        const btn = NidaraButton({
            label: resp.label,
            variant: resp.destructive ? "danger" : resp.suggested ? "primary" : "secondary",
            sensitive: resp.sensitive !== false,
        })
        btn.hexpand = true
        btn.connect("clicked", () => onClick(resp.id))
        buttons.set(resp.id, btn)
        box.append(btn)
    }
    return { box, buttons }
}
