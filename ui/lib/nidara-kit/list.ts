import { Gtk } from "ags/gtk4"

export interface NidaraListResult {
    /** Outer column: optional title + the list card. Append this to the page. */
    box: Gtk.Box
    /** The Gtk.ListBox card. Append NidaraRow children here. */
    listBox: Gtk.ListBox
}

/**
 * NidaraList — the ONE place a boxed list card is built.
 *
 * A frosted card (class `nidara-list`, = material-card) with an optional
 * uppercase title above it, holding NidaraRow children. Used by Settings groups,
 * Control Center detail lists and any future surface — never reinvent a
 * per-surface list class. See feedback_universal_components.
 *
 * @example
 *   const { box, listBox } = NidaraList("Network")
 *   listBox.append(NidaraRow("Wi-Fi", "", toggle))
 *   page.append(box)
 */
export function NidaraList(title: string = "", extraClasses: string[] = []): NidaraListResult {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        css_classes: ["nidara-list-group"],
    })

    if (title) {
        box.append(new Gtk.Label({
            label: title.toUpperCase(),
            css_classes: ["nidara-list-title"],
            halign: Gtk.Align.START, margin_start: 10,
        }))
    }

    const listBox = new Gtk.ListBox({
        css_classes: ["nidara-list", ...extraClasses],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    box.append(listBox)
    return { box, listBox }
}
