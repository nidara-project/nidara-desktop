import Gtk from "gi://Gtk?version=4.0"
import GObject from "gi://GObject"

/**
 * NidaraPickList — a `Gtk.ListBox` that is ONE tab stop, not one per row.
 *
 * Use it for a list of CHOICES — 249 countries, the timezones, a navigation
 * sidebar — where the rows are data and the list is the control. Do NOT use it
 * for a list of CONTROLS (a Settings group, a form): there each row holds a
 * switch or an entry the person has to reach, and reaching them one Tab at a
 * time is correct. GNOME's own preferences work that way, and so do ours.
 *
 * ## Why a subclass and not a key handler
 *
 * GTK4 makes every `GtkListBoxRow` focusable, so Tab walks them: measured in the
 * installer on 2026-09-03, reaching the footer from the language list took
 * fifteen presses, and the country list is 249 (#403, D-04). What newer item
 * views (`GtkListView`, `GtkColumnView`) do instead is exactly this — arrows move
 * the cursor INSIDE, Tab moves past the whole thing — and they do it in their
 * `focus` vfunc. This is that behaviour, for the list widget we actually use.
 *
 * The rule is one line: **if the focus is already inside, Tab does not move it
 * within me.** Returning false from `vfunc_focus` is how a widget says "focus
 * cannot travel further inside me in this direction", which sends the parent
 * looking at the next sibling. Everything else — entering the list, Up/Down
 * between rows, Enter to activate — is GtkListBox's own behaviour, chained up
 * untouched, so the rows keep REAL focus: the focus ring is the platform's, and
 * AT-SPI still reports which row a screen reader is on.
 *
 * ⚠️ Rows still have to be focusable for that. A list whose rows are
 * `focusable: false` (the partition table's, whose rows hold dropdowns) is a
 * different case and does not want this class.
 */
export class NidaraPickList extends Gtk.ListBox {
    static {
        GObject.registerClass({ GTypeName: "NidaraPickList" }, this)
    }

    vfunc_focus(direction: Gtk.DirectionType): boolean {
        const tabbing = direction === Gtk.DirectionType.TAB_FORWARD
            || direction === Gtk.DirectionType.TAB_BACKWARD
        if (!tabbing) return super.vfunc_focus(direction)

        // Inside already → let Tab out. Outside → let GtkListBox bring it in at
        // the edge it would normally enter from (first row forwards, last row
        // backwards), which is why this is not simply `return false`.
        const focus = (this.get_root() as any)?.get_focus?.() as Gtk.Widget | null
        if (focus && (focus === this || focus.is_ancestor(this))) return false
        return super.vfunc_focus(direction)
    }
}

export interface NidaraListResult {
    /** Outer column: optional title + the list card. Append this to the page. */
    box: Gtk.Box
    /** The Gtk.ListBox card. Append NidaraRow children here. */
    listBox: Gtk.ListBox
    /** The title label, when a `title` was given. Exposed for the same reason
     *  `footerLabel` is: a surface that re-translates itself in place (the
     *  installer's summary rebuilds its rows on every language change) cannot
     *  reach the header any other way, and digging it out of `box`'s children is
     *  how a caller ends up depending on the order they are appended in. */
    titleLabel?: Gtk.Label
    /** The footer label, when a `footer` was given. Exposed so a caller can show or
     *  hide prose that only applies to some states — Settings → Dock's side-position
     *  note. Callers that always show their footer never touch it. */
    footerLabel?: Gtk.Label
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
    opts: { pick?: boolean } = {},
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

    let titleLabel: Gtk.Label | undefined
    if (title) {
        titleLabel = new Gtk.Label({
            label: title.toUpperCase(),
            css_classes: ["nidara-list-title"],
            halign: Gtk.Align.START, margin_start: 16,
        })
        box.append(titleLabel)
    }

    // `pick: true` when the rows are CHOICES rather than controls — see
    // NidaraPickList for the distinction and why it changes the tab ring.
    const listBox = new (opts.pick ? NidaraPickList : Gtk.ListBox)({
        css_classes: ["nidara-list", ...extraClasses],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    box.append(listBox)

    let footerLabel: Gtk.Label | undefined
    if (footer) {
        // Mirrors the title's indent (widget margin + the class's own margin-left)
        // so header, card and footer share one left edge. Wraps: this is prose, and
        // Settings is resizable.
        footerLabel = new Gtk.Label({
            label: footer,
            css_classes: ["nidara-list-footer"],
            // Fills its column for the same reason a row subtitle does — see the note
            // in row.ts. A footer and the subtitles above it are the same kind of
            // prose sitting inches apart; they must break at the same edge.
            halign: Gtk.Align.FILL, hexpand: true, xalign: 0, margin_start: 16,
            margin_end: 16, wrap: true,
        })
        box.append(footerLabel)
    }

    return { box, listBox, titleLabel, footerLabel }
}
