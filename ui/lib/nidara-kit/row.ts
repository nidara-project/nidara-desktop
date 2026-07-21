import { Gtk } from "ags/gtk4"

export interface NidaraRowResult {
    row: Gtk.ListBoxRow
    /** The horizontal content box, in case a caller needs to tweak it. */
    box: Gtk.Box
}

/**
 * NidaraRow — the ONE place a list/menu row is built.
 *
 * A Gtk.ListBoxRow (class `nidara-row`) with a title, optional subtitle, and an
 * optional trailing control (switch, dropdown, button…). Hover/press/select come
 * from `.nidara-row` in _components.scss (single source, mode-aware). Used by
 * Settings, Control Center and any future surface — never reinvent a per-surface
 * row class. See feedback_universal_components.
 *
 * @example
 *   const r = NidaraRow("Wi-Fi", "Connected", toggle)
 *   listBox.append(r)
 */
/** Title + optional subtitle, the text column shared by both row shapes. */
function textColumn(label: string, subtitle: string, titleIcon?: Gtk.Widget): Gtk.Box {
    const text = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        hexpand: true, valign: Gtk.Align.CENTER,
    })
    const titleLabel = new Gtk.Label({
        label, css_classes: ["nidara-row-title"],
        halign: Gtk.Align.START, xalign: 0, wrap: true,
    })
    if (titleIcon) {
        const titleLine = new Gtk.Box({ spacing: 6, halign: Gtk.Align.START })
        titleLine.append(titleLabel)
        titleLine.append(titleIcon)
        text.append(titleLine)
    } else {
        text.append(titleLabel)
    }
    if (subtitle) {
        text.append(new Gtk.Label({
            label: subtitle, css_classes: ["nidara-row-subtitle"],
            halign: Gtk.Align.START, xalign: 0, wrap: true,
        }))
    }
    return text
}

/**
 * NidaraStackedRow — same row, control on its OWN LINE underneath, full width.
 *
 * Use when the control needs room to breathe: a text entry with buttons, a long
 * path, a search field. In the horizontal `NidaraRow` the text column takes
 * `hexpand`, so a wide control gets squeezed into whatever is left — an API-key
 * entry ends up comically narrow (user-caught 2026-07-21). This is a layout
 * choice, not a new component: same `.nidara-row` chrome, same title/subtitle.
 */
export function NidaraStackedRow(
    label: string,
    subtitle: string = "",
    control?: Gtk.Widget,
    extraClasses: string[] = [],
): Gtk.ListBoxRow {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 10,
        margin_start: 16, margin_end: 16, margin_top: 14, margin_bottom: 14,
    })
    box.append(textColumn(label, subtitle))
    if (control) {
        control.hexpand = true
        box.append(control)
    }
    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row", ...extraClasses] })
    row.set_child(box)
    return row
}

export function NidaraRow(
    label: string,
    subtitle: string = "",
    control?: Gtk.Widget,
    extraClasses: string[] = [],
    /** Small icon shown right after the title (e.g. a lock on a secured Wi-Fi row). */
    titleIcon?: Gtk.Widget,
    /** Icon shown BEFORE the title, leading the row (e.g. a widget/app identity icon). */
    leadingIcon?: Gtk.Widget,
): Gtk.ListBoxRow {
    const box = new Gtk.Box({
        spacing: 16, margin_start: 16, margin_end: 16, margin_top: 14, margin_bottom: 14,
    })

    if (leadingIcon) box.append(leadingIcon)

    const text = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        hexpand: true, valign: Gtk.Align.CENTER,
    })
    const titleLabel = new Gtk.Label({
        label, css_classes: ["nidara-row-title"],
        halign: Gtk.Align.START, xalign: 0, wrap: true,
    })
    if (titleIcon) {
        const titleLine = new Gtk.Box({ spacing: 6, halign: Gtk.Align.START })
        titleLine.append(titleLabel)
        titleLine.append(titleIcon)
        text.append(titleLine)
    } else {
        text.append(titleLabel)
    }
    if (subtitle) {
        // wrap lets a long subtitle shrink/wrap instead of forcing the text column
        // wide and pushing the trailing control out of alignment.
        text.append(new Gtk.Label({
            label: subtitle, css_classes: ["nidara-row-subtitle"],
            halign: Gtk.Align.START, xalign: 0, wrap: true,
        }))
    }

    box.append(text)
    if (control) box.append(control)

    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row", ...extraClasses] })
    row.set_child(box)
    return row
}
