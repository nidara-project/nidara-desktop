import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { NidaraEmptyRow, ROW_H_SINGLE } from "./row"

/**
 * How far apart two cells sit. The row's own text↔control gap is 16
 * (`NidaraRow`), which is right when there are two things in a row and too airy
 * when there are six: a table's columns are read as a grid, and the eye needs the
 * columns to be closer to each other than the row is to the card's edge.
 */
const CELL_SPACING = 12

/**
 * The inset from the CARD's edge to a row's content, so the header can be lined
 * up with the cells underneath it: 1px card border + 3px card padding
 * (`.nidara-list`) + the 16px content margin every row in this kit carries.
 *
 * It is spelled out rather than eyeballed because the header lives OUTSIDE the
 * card — same reason `.nidara-list-title` carries `margin_start: 16` plus its
 * own `margin-left: 4`. A column heading one pixel off its column reads as a
 * different mistake than it is.
 */
const HEADER_INSET = 20

export interface NidaraTableColumn {
    /** The column heading. Keep it a noun — it names the cells, it is not a title. */
    title: string
    /** This column takes the leftover width. Normally exactly one column does. */
    expand?: boolean
    /** Where the cells sit in their column (default START; a size column is END). */
    align?: Gtk.Align
    /** Secondary information — the cells are dimmed, the heading is not. */
    dim?: boolean
    /** A floor in px, for a column whose widest cell is not what should size it. */
    minWidth?: number
    /**
     * Reserve the column width from the control's model (e.g. a `Gtk.DropDown`'s
     * widest option) rather than its selected item. Defaults to `true` when a
     * cell holds a `Gtk.DropDown`, ensuring column stability. Set to `false`
     * to opt out.
     */
    reserveFromModel?: boolean
}

export interface NidaraTableResult {
    /** Column headings + the list card. Append this to the page. */
    box: Gtk.Box
    /** The card itself, for a caller that needs to reach the rows. */
    listBox: Gtk.ListBox
    /** One row: a widget (or a string) per column, in column order. */
    appendRow(cells: Array<Gtk.Widget | string>, extraClasses?: string[]): Gtk.ListBoxRow
    /** The "there is nothing here" row — spans the table instead of the columns. */
    appendMessage(text: string): Gtk.ListBoxRow
    /**
     * A full-width heading INSIDE the list, naming the group of rows under it —
     * a disk, in the installer's case.
     *
     * It is a row rather than a second table because the alternative is one table
     * per group, and then the columns of each stop lining up: the size groups are
     * per-table, so two disks would measure two different `Mount point` columns
     * and the page would read as two unrelated things.
     */
    appendSection(text: string): Gtk.ListBoxRow
    /** Empty the card. The headings stay: a table with no rows is still a table. */
    clear(): void
}

/**
 * NidaraTable — the ONE place a table with column headings is built.
 *
 * A `NidaraList` card whose rows are cells in aligned columns, under a row of
 * headings. Everything a row's chrome gives you — the height token, the hover
 * fill, the radius, the card — is the same as `NidaraRow`'s, because this IS a
 * `.nidara-row`; what it adds is the one thing a row cannot express: several
 * values per line, each under a heading that says what it is.
 *
 * @example
 *   const t = NidaraTable([
 *     { title: "Partition", expand: true },
 *     { title: "Size", align: Gtk.Align.END, dim: true },
 *     { title: "Mount point" },
 *   ])
 *   t.appendRow(["/dev/nvme0n1p1", "512 MiB", mountDropDown])
 *   page.append(t.box)
 *
 * ## Why a ListBox and size groups, and not a `Gtk.Grid`
 *
 * A grid aligns columns for free and that is the whole of its appeal. What it
 * cannot do is be a row: `.nidara-row`'s hover fill, its `min-height` token and
 * its corner radius all belong to ONE widget spanning the line, and in a grid a
 * line is n unrelated children. Painting a fill behind them means a background
 * widget under every row and a second implementation of the interaction model
 * that `_base.scss` already owns — a per-surface row, which is exactly what the
 * kit exists to prevent (see `feedback_universal_components`).
 *
 * So the rows stay rows, and the alignment is bought with one
 * `Gtk.SizeGroup` per column, joining that column's heading to every cell under
 * it. Each row then lays its cells out identically, because they are the same
 * widths in the same order inside boxes of the same width.
 *
 * ## What the columns cost
 *
 * A size group reports the WIDEST member, so a table is as wide as the sum of
 * its widest cells — it does not fold, and it must not be given a pane narrower
 * than that (the columns would be squeezed one by one, and a squeezed dropdown
 * is a control nobody can read). A surface adopting this component measures the
 * table and sizes its pane from that measurement, never the other way round;
 * `WINDOW_LAYOUT.wizardContent` is set from this table's own measurement for
 * exactly that reason.
 */
function findDropDown(widget: Gtk.Widget | string): Gtk.DropDown | null {
    if (typeof widget === "string") return null
    if (widget instanceof Gtk.DropDown) return widget
    if (widget instanceof Gtk.Box) {
        let child = widget.get_first_child()
        while (child) {
            const found = findDropDown(child)
            if (found) return found
            child = child.get_next_sibling()
        }
    }
    return null
}

function getLongestItemIndex(model: any): number {
    let longest = 0
    let maxLen = -1
    const n = typeof model?.get_n_items === "function" ? model.get_n_items() : 0
    for (let j = 0; j < n; j++) {
        let text = ""
        if (model instanceof Gtk.StringList) {
            text = model.get_string(j) ?? ""
        } else {
            const item = model.get_item(j)
            if (item instanceof Gtk.StringObject) {
                text = item.get_string() ?? ""
            } else if (typeof (item as any)?.get_string === "function") {
                text = (item as any).get_string() ?? ""
            } else if (typeof (item as any)?.name === "string") {
                text = (item as any).name
            } else if (item != null) {
                text = String(item)
            }
        }
        if (text.length > maxLen) {
            maxLen = text.length
            longest = j
        }
    }
    return longest
}

export function NidaraTable(
    columns: NidaraTableColumn[],
    extraClasses: string[] = [],
): NidaraTableResult {
    // spacing:0 for the same reason NidaraList uses it — the heading↔card gap is
    // owned by `.nidara-table-heading`'s margin-bottom, so the headings bind to
    // the card below them rather than floating between two groups.
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 0,
        css_classes: ["nidara-list-group"],
    })

    const groups = columns.map(() => new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL }))

    const headerBox = new Gtk.Box({
        spacing: CELL_SPACING,
        css_classes: ["nidara-table-header"],
        margin_start: HEADER_INSET, margin_end: HEADER_INSET,
    })
    columns.forEach((col, i) => {
        const cell = new Gtk.Label({
            label: col.title,
            css_classes: ["nidara-table-heading"],
            halign: col.align ?? Gtk.Align.START,
            xalign: col.align === Gtk.Align.END ? 1 : 0,
            // A heading does not wrap and does not push its column wider than the
            // data under it: the cells are what the column is for.
            wrap: false, ellipsize: Pango.EllipsizeMode.END,
        })
        if (col.expand) cell.hexpand = true
        if (col.minWidth) cell.width_request = col.minWidth
        groups[i].add_widget(cell)
        headerBox.append(cell)
    })
    box.append(headerBox)

    // Invisible container hosting dummy reservation widgets in the widget hierarchy
    // so they have valid root and CSS style contexts without affecting layout or
    // polluting headerBox / row traversals.
    const reserveBox = new Gtk.Box({ visible: false })
    box.append(reserveBox)

    interface ReserveEntry {
        col: number
        drop: Gtk.DropDown
        dummy?: Gtk.DropDown
        handlerId?: number
    }
    const reserveEntries: ReserveEntry[] = []

    const listBox = new Gtk.ListBox({
        css_classes: ["nidara-list", ...extraClasses],
        selection_mode: Gtk.SelectionMode.NONE,
    })
    box.append(listBox)

    const cellWidget = (cell: Gtk.Widget | string, col: NidaraTableColumn): Gtk.Widget => {
        if (typeof cell !== "string") {
            // ⚠️ A control cell is WRAPPED, and it has to be. The size group makes
            // every member request the column's width, which leaves `halign`
            // nothing to distribute: a checkbox in a column headed "Format" came
            // out 62px wide with its indicator against the left edge, under a
            // heading it was supposed to sit beneath. The wrapper takes the
            // column's width; the control aligns inside it.
            //
            // FILL by default, because a dropdown that spans its column keeps the
            // table's vertical rules straight — a column of controls at their
            // natural widths is a ragged edge. A column that wants otherwise says
            // so with `align`.
            cell.halign = col.align ?? Gtk.Align.FILL
            const holder = new Gtk.Box()
            holder.append(cell)
            return holder
        }
        return new Gtk.Label({
            label: cell,
            css_classes: col.dim
                ? ["nidara-table-cell", "nidara-table-cell--dim"]
                : ["nidara-table-cell"],
            halign: col.align ?? Gtk.Align.START,
            xalign: col.align === Gtk.Align.END ? 1 : 0,
            // Ellipsised, never wrapped, for the reason a row title is (see row.ts):
            // the row DECLARES its height, and a cell that can take two lines makes
            // that declaration a lie for some rows and not others.
            wrap: false, ellipsize: Pango.EllipsizeMode.END,
        })
    }

    const appendRow = (cells: Array<Gtk.Widget | string>, rowClasses: string[] = []) => {
        if (headerBox.has_css_class("nidara-table-header--dim")) {
            headerBox.remove_css_class("nidara-table-header--dim")
            listBox.set_placeholder(null)
        }

        const line = new Gtk.Box({ spacing: CELL_SPACING })
        columns.forEach((col, i) => {
            const rawCell = cells[i] ?? ""
            const w = cellWidget(rawCell, col)
            w.valign = Gtk.Align.CENTER
            if (col.expand) w.hexpand = true
            if (col.minWidth) w.width_request = col.minWidth
            groups[i].add_widget(w)
            line.append(w)

            // #464: Size the column from the control's model rather than its current
            // selection. An unselected/short dropdown button reports only its active
            // item, causing the column to jump when the user picks a wider answer.
            // When reserveFromModel is enabled (default true for DropDown), we attach
            // a hidden dummy DropDown with the model's longest item selected to the
            // column's size group.
            if (col.reserveFromModel !== false) {
                const drop = findDropDown(rawCell)
                if (drop) {
                    const entry: ReserveEntry = { col: i, drop }
                    const syncDummy = () => {
                        if (!drop.model || drop.model.get_n_items() === 0) return
                        const longest = getLongestItemIndex(drop.model)
                        if (!entry.dummy) {
                            entry.dummy = new Gtk.DropDown({
                                model: drop.model,
                                selected: longest,
                                visible: false,
                            })
                            reserveBox.append(entry.dummy)
                            groups[i].add_widget(entry.dummy)
                        } else {
                            entry.dummy.model = drop.model
                            entry.dummy.selected = longest
                        }
                    }
                    syncDummy()
                    entry.handlerId = drop.connect("notify::model", syncDummy)
                    reserveEntries.push(entry)
                }
            }
        })
        line.margin_start = 16; line.margin_end = 16
        line.margin_top = 8; line.margin_bottom = 8

        const row = new Gtk.ListBoxRow({
            // A table row holds controls, so the row itself is not a control: it is
            // neither activatable nor selectable, and it does not take the focus —
            // its cells do.
            //
            // ⚠️ `focusable: false`, NEVER `can_focus: false`. The second one makes
            // every DESCENDANT unfocusable too, which in a row whose whole point is
            // to hold dropdowns means they can be clicked and never keyed. That trap
            // has already cost this repo the installer's account step once — see the
            // note in `NidaraStackedRow`.
            activatable: false, selectable: false, focusable: false,
            css_classes: ["nidara-row", ROW_H_SINGLE, "nidara-table-row", ...rowClasses],
        })
        row.set_child(line)
        listBox.append(row)
        return row
    }

    const appendSection = (text: string) => {
        // ⚠️ The child is the LABEL, not a Box, and that is load-bearing: `clear`
        // walks a row's Box children to take them OFF the size groups, and a
        // section's single cell was never IN one. Handing it a non-Box child
        // makes it skip by construction rather than by a special case that a
        // later edit can forget.
        const row = new Gtk.ListBoxRow({
            child: new Gtk.Label({
                label: text, halign: Gtk.Align.START, xalign: 0,
                css_classes: ["nidara-table-section"],
                // Ellipsised, and that is what keeps a long group name from
                // widening the pane: an ellipsising label still reports the full
                // text as its NATURAL width, so without the clamp the caller puts
                // around this table a 60-character disk model would push every
                // column. With it, the name truncates and the columns do not move.
                wrap: false, ellipsize: Pango.EllipsizeMode.END,
            }),
            css_classes: ["nidara-row", "nidara-table-section-row"],
            activatable: false, selectable: false, focusable: false,
        })
        listBox.append(row)
        return row
    }

    const appendMessage = (text: string) => {
        const row = NidaraEmptyRow(text)
        listBox.set_placeholder(row)
        headerBox.add_css_class("nidara-table-header--dim")
        return row
    }

    const clear = () => {
        if (headerBox.has_css_class("nidara-table-header--dim")) {
            headerBox.remove_css_class("nidara-table-header--dim")
        }
        listBox.set_placeholder(null)

        // Clean up reservation widgets and signal handlers so size groups do not leak
        // or stay locked to the widest widget ever seen.
        for (const entry of reserveEntries) {
            if (entry.handlerId) {
                entry.drop.disconnect(entry.handlerId)
            }
            if (entry.dummy) {
                groups[entry.col].remove_widget(entry.dummy)
                reserveBox.remove(entry.dummy)
            }
        }
        reserveEntries.length = 0

        let child = listBox.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            // Off the size groups as well: a group holds a reference and keeps
            // measuring a widget nobody can see, so a table that is rebuilt (the
            // installer's Refresh) would keep every column as wide as the widest
            // cell it EVER held.
            const line = (child as Gtk.ListBoxRow).get_child()
            if (line instanceof Gtk.Box) {
                let cell = line.get_first_child()
                for (let i = 0; cell && i < groups.length; i++) {
                    groups[i].remove_widget(cell)
                    cell = cell.get_next_sibling()
                }
            }
            listBox.remove(child)
            child = next
        }
    }

    return { box, listBox, appendRow, appendMessage, appendSection, clear }
}
