import { Gtk } from "ags/gtk4"

export interface CrystalListResult {
    /** Outer column: optional title + the list card. Append this to the page. */
    box: Gtk.Box
    /** The Gtk.ListBox card. Append CrystalRow children here. */
    listBox: Gtk.ListBox
}

/**
 * CrystalList — the ONE place a boxed list card is built.
 *
 * A frosted card (class `crystal-list`, = material-card) with an optional
 * uppercase title above it, holding CrystalRow children. Used by Settings groups,
 * Control Center detail lists and any future surface — never reinvent a
 * per-surface list class. See feedback_universal_components.
 *
 * @example
 *   const { box, listBox } = CrystalList("Network")
 *   listBox.append(CrystalRow("Wi-Fi", "", toggle))
 *   page.append(box)
 */
export function CrystalList(title: string = "", extraClasses: string[] = []): CrystalListResult {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        css_classes: ["crystal-list-group"],
    })

    if (title) {
        box.append(new Gtk.Label({
            label: title.toUpperCase(),
            css_classes: ["crystal-list-title"],
            halign: Gtk.Align.START, margin_start: 10,
        }))
    }

    const listBox = new Gtk.ListBox({
        css_classes: ["crystal-list", ...extraClasses],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    box.append(listBox)
    return { box, listBox }
}
