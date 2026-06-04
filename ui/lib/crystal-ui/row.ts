import { Gtk } from "ags/gtk4"

export interface CrystalRowResult {
    row: Gtk.ListBoxRow
    /** The horizontal content box, in case a caller needs to tweak it. */
    box: Gtk.Box
}

/**
 * CrystalRow — the ONE place a list/menu row is built.
 *
 * A Gtk.ListBoxRow (class `crystal-row`) with a title, optional subtitle, and an
 * optional trailing control (switch, dropdown, button…). Hover/press/select come
 * from `.crystal-row` in _components.scss (single source, mode-aware). Used by
 * Settings, Control Center and any future surface — never reinvent a per-surface
 * row class. See feedback_universal_components.
 *
 * @example
 *   const r = CrystalRow("Wi-Fi", "Connected", toggle)
 *   listBox.append(r)
 */
export function CrystalRow(
    label: string,
    subtitle: string = "",
    control?: Gtk.Widget,
    extraClasses: string[] = [],
): Gtk.ListBoxRow {
    const box = new Gtk.Box({
        spacing: 16, margin_start: 16, margin_end: 16, margin_top: 14, margin_bottom: 14,
    })

    const text = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        hexpand: true, valign: Gtk.Align.CENTER,
    })
    text.append(new Gtk.Label({
        label, css_classes: ["crystal-row-title"],
        halign: Gtk.Align.START, xalign: 0, wrap: true,
    }))
    if (subtitle) {
        // wrap lets a long subtitle shrink/wrap instead of forcing the text column
        // wide and pushing the trailing control out of alignment.
        text.append(new Gtk.Label({
            label: subtitle, css_classes: ["crystal-row-subtitle"],
            halign: Gtk.Align.START, xalign: 0, wrap: true,
        }))
    }

    box.append(text)
    if (control) box.append(control)

    const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row", ...extraClasses] })
    row.set_child(box)
    return row
}
