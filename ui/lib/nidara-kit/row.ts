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
            // FILL + hexpand, NOT halign START. A halign-START label is allocated its
            // NATURAL width, and a wrapping GtkLabel's natural width is a line-balancing
            // heuristic — so every description picked its own break column and the page
            // read as random: measured live 2026-07-27 with `ags request queryUI`, these
            // same subtitles came out 310, 332, 369, 372, 442, 456, 480, 486, 493, 501,
            // 540, 556, 567 and 589 px wide, one line here, two there, at no consistent
            // edge. Filling the column makes the width identical for every row, so a
            // break happens only where the card actually ends. `xalign: 0` keeps the
            // text left-aligned inside that full-width box.
            halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true,
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
    /**
     * A SECOND line INSIDE the row, under the text column — for a secondary
     * control that belongs to this item but must not compete with `control` for
     * the trailing slot (Settings → Widgets puts "Configure" here).
     *
     * Not the same thing as `NidaraStackedRow`, which replaces the horizontal
     * shape entirely: here line 1 keeps its title + trailing control exactly as
     * it is, so a column of trailing controls stays aligned even though only
     * some rows carry a footer. That is the whole reason this exists — the
     * alternative, a sibling row underneath, reads as another ITEM in the list
     * rather than as part of this one (user-caught 2026-08-02).
     *
     * The caller owns the footer's `halign` and its `margin_start` (the indent
     * that lines it up with the title — leading-icon width + 16px spacing;
     * NidaraRow cannot know the icon's size). Keep it visually lighter than the
     * title: ghost + compact is the house style for a control in this slot.
     */
    footer?: Gtk.Widget,
): Gtk.ListBoxRow {
    const line = new Gtk.Box({ spacing: 16 })

    if (leadingIcon) line.append(leadingIcon)

    // textColumn, not a copy of it. This function used to inline its own — byte for
    // byte the same widgets — which is why a fix applied to `textColumn` changed the
    // stacked rows and left every ordinary row untouched (caught live 2026-07-27,
    // after the fix "did nothing"). The helper's docstring already claimed both
    // shapes shared it; now they do.
    line.append(textColumn(label, subtitle, titleIcon))
    if (control) line.append(control)

    // The row's padding always sits on the OUTERMOST box, so a footer row has the
    // same outer metrics as a plain one and only adds its own line — without a
    // footer this is `line` itself, byte-identical to the original layout.
    let content: Gtk.Box = line
    if (footer) {
        content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
        content.append(line)
        content.append(footer)
    }
    content.margin_start = 16; content.margin_end = 16
    content.margin_top = 14; content.margin_bottom = 14

    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row", ...extraClasses] })
    row.set_child(content)
    return row
}
