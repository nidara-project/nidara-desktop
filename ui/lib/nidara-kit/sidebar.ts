import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"

export interface NidaraSidebarItem {
    id: string
    label: string
    /** Symbolic gicon shown before the label (tinted via .nd-icon). */
    icon?: Gio.FileIcon
    /** Draw a thin, title-less divider before this item (macOS-style thematic
     *  clustering). Ignored on the first item. Non-selectable, non-activatable. */
    groupStart?: boolean
}

export interface NidaraSidebarResult {
    /** The Gtk.ListBox — drop it into a ScrolledWindow / capsule. */
    widget: Gtk.ListBox
    /** Select the row with this id programmatically (does NOT fire onSelect). */
    select: (id: string) => void
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
            margin_start: 14, margin_end: 14,
            valign: Gtk.Align.CENTER,
        })
        if (item.icon) {
            const icon = new Gtk.Image({ pixel_size: 18, css_classes: ["nd-icon"] })
            icon.gicon = item.icon
            content.append(icon)
        }
        content.append(new Gtk.Label({ label: item.label, css_classes: ["nidara-sidebar-label"] }))

        const row = new Gtk.ListBoxRow()
        row.set_child(content)
        row.set_name(item.id)
        list.append(row)
    })

    list.connect("row-activated", (_: Gtk.ListBox, row: Gtk.ListBoxRow) => {
        if (row?.name) onSelect(row.name)
    })

    const select = (id: string) => {
        for (let i = 0; ; i++) {
            const row = list.get_row_at_index(i)
            if (!row) break
            if (row.get_name() === id) { list.select_row(row); return }
        }
    }

    return {
        widget: list,
        select,
        unselectAll: () => list.unselect_all(),
        getSelectedId: () => list.get_selected_row()?.get_name() ?? null,
    }
}
