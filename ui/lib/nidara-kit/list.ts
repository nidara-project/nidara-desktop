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
 * An optional `footer` prints small dimmed prose UNDER the card. It is for the
 * scope a title cannot carry — who a group applies to, what it deliberately does
 * NOT cover — which is the macOS/iOS group-footer idiom. Use it when a user could
 * reasonably misread the group's reach; do not use it for per-row explanation,
 * which belongs in the row's own subtitle.
 *
 * @example
 *   const { box, listBox } = NidaraList("Network")
 *   listBox.append(NidaraRow("Wi-Fi", "", toggle))
 *   page.append(box)
 */
export function NidaraList(
    title: string = "", extraClasses: string[] = [], footer: string = "",
): NidaraListResult {
    // spacing:0 — the title→card gap is owned entirely by .nidara-list-title's
    // margin-bottom (design-system.md), so the header binds to the card BELOW it.
    // Group↔group separation is the page-level spacing (settings-page, 24px); the
    // header must sit clearly closer to its own card than to the previous group
    // (macOS/Adwaita section-header convention), not float halfway between them.
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 0,
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

    if (footer) {
        // Mirrors the title's indent (widget margin + the class's own margin-left)
        // so header, card and footer share one left edge. Wraps: this is prose, and
        // Settings is resizable.
        box.append(new Gtk.Label({
            label: footer,
            css_classes: ["nidara-list-footer"],
            // Fills its column for the same reason a row subtitle does — see the note
            // in row.ts. A footer and the subtitles above it are the same kind of
            // prose sitting inches apart; they must break at the same edge.
            halign: Gtk.Align.FILL, hexpand: true, xalign: 0, margin_start: 10,
            margin_end: 10, wrap: true,
        }))
    }

    return { box, listBox }
}
