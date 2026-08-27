import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import Pango from "gi://Pango"

export interface NidaraSidebarItem {
    id: string
    label: string
    /** Symbolic gicon shown before the label (tinted via .nd-icon). */
    icon?: Gio.FileIcon
    /** Draw a thin, title-less divider before this item (thematic
     *  clustering). Ignored on the first item. Non-selectable, non-activatable. */
    groupStart?: boolean
}

export interface NidaraSidebarResult {
    /** The Gtk.ListBox — drop it into a ScrolledWindow / capsule. */
    widget: Gtk.ListBox
    /** Select the row with this id programmatically (does NOT fire onSelect). */
    select: (id: string) => void
    /** Set whether a specific row is sensitive, selectable and activatable. */
    setItemSensitive: (id: string, sensitive: boolean) => void
    /** Clear the selection. */
    unselectAll: () => void
    /** Currently selected id, or null. */
    getSelectedId: () => string | null
}

/**
 * NidaraSidebar — the ONE place a navigation sidebar is built.
 *
 * A single-select Gtk.ListBox (class `nidara-sidebar`) of icon+label rows;
 * selection paints accent, hover/press deepen via the shared interaction model.
 * `onSelect` fires on USER activation only (clicks), never on programmatic
 * `select()` — so callers can sync selection without re-entrancy. Reuse this for
 * any window (Settings today, others tomorrow) instead of hand-rolling a ListBox.
 * See feedback_universal_components.
 *
 * @example
 *   const sb = NidaraSidebar(items, (id) => navigateTo(id))
 *   scroll.set_child(sb.widget)
 *   sb.select("audio")
 */
export function NidaraSidebar(
    items: NidaraSidebarItem[],
    onSelect: (id: string) => void,
    opts: { extraClasses?: string[] } = {},
): NidaraSidebarResult {
    const list = new Gtk.ListBox({
        css_classes: ["nidara-sidebar", ...(opts.extraClasses ?? [])],
        selection_mode: Gtk.SelectionMode.SINGLE,
        activate_on_single_click: true,
        vexpand: true,
    })

    items.forEach((item, i) => {
        // Thematic divider before a group (never before the first item). It's a
        // non-selectable/non-activatable row so it stays out of keyboard/selection.
        if (item.groupStart && i > 0) {
            const divider = new Gtk.ListBoxRow({
                css_classes: ["sidebar-divider"],
                selectable: false,
                activatable: false,
            })
            divider.set_child(new Gtk.Box({ css_classes: ["sidebar-divider-line"] }))
            list.append(divider)
        }

        const content = new Gtk.Box({
            spacing: 12,
            css_classes: ["nidara-sidebar-item"],
            margin_start: 12, margin_end: 12,
            valign: Gtk.Align.CENTER,
        })
        if (item.icon) {
            const icon = new Gtk.Image({ pixel_size: 18, css_classes: ["nd-icon"] })
            icon.gicon = item.icon
            content.append(icon)
        }
        // ⚠️ ELLIPSIZE, and it is structural rather than cosmetic. This label carries
        // no font-size rule, so it grows with the interface font — and the capsule
        // around it is a FIXED column (`sidebarWidth`, 250px in Settings) whose scroll
        // view is `hscrollbar_policy: NEVER`. Without ellipsizing, the label's minimum
        // width IS its natural width, so a long string makes the capsule demand more
        // than its column reserves and it overruns the content pane.
        //
        // The budget is **174px**, and it is smaller than it looks: 250 − 8 capsule
        // margin − 2 capsule BORDER − 12 list padding − 0 row padding (opted out via
        // padding: 0) − 24 row margins − 18 icon − 12 spacing.
        //
        // Russian "Специальные возможности" needed 200px AT THE DEFAULT SIZE — broken
        // in a shipped locale before any accessibility scaling — and is abbreviated in
        // `ru.ts` for exactly that reason. Japanese goes at factor 1.25, English
        // "Language & region" at 1.39.
        //
        // 🔑 None of those numbers is a note to trust: `scripts/dev/text-budget.js`
        // measures all 12 locales against this budget on every CI run, and its
        // `--verify` mode re-derives the budget from a live window, which is how the
        // 6px error above was found.
        content.append(new Gtk.Label({
            label: item.label,
            css_classes: ["nidara-sidebar-label"],
            ellipsize: Pango.EllipsizeMode.END,
            xalign: 0,
            hexpand: true,
        }))

        const row = new Gtk.ListBoxRow()
        row.set_child(content)
        row.set_name(item.id)
        list.append(row)
    })

    list.connect("row-activated", (_: Gtk.ListBox, row: Gtk.ListBoxRow) => {
        const id = row?.get_name() || (row as any)?.name
        if (id) onSelect(id)
    })

    const select = (id: string) => {
        for (let i = 0; ; i++) {
            const row = list.get_row_at_index(i)
            if (!row) break
            if (row.get_name() === id) { list.select_row(row); return }
        }
    }

    const setItemSensitive = (id: string, sensitive: boolean) => {
        for (let i = 0; ; i++) {
            const row = list.get_row_at_index(i)
            if (!row) break
            if (row.get_name() === id) {
                row.set_sensitive(sensitive)
                row.set_activatable(sensitive)
                row.set_selectable(sensitive)
                return
            }
        }
    }

    return {
        widget: list,
        select,
        setItemSensitive,
        unselectAll: () => list.unselect_all(),
        getSelectedId: () => list.get_selected_row()?.get_name() ?? null,
    }
}
