import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

// MenuModelLike / ActionGroupLike aren't surfaced by the @girs stub here, and
// AstalTray hands them over loosely typed anyway — alias them.
type MenuModelLike = any
type ActionGroupLike = any

// Renders a DBus Gio.MenuModel (e.g. a tray item's context menu) into a plain
// Gtk.Box of nidara rows — NOT a Gtk.Popover. It's dropped into the bar's shared
// expansion capsule (same glass/fade/positioning as every other bar popover).
//
// IMPORTANT — keep introspection minimal. Querying the DBus action group at build
// time (get_action_enabled / get_action_state) could hard-crash GJS for some
// apps, so we DON'T: we only read labels/actions/links (exactly what GTK's own
// PopoverMenu reads in C) and activate the action on click. Everything is wrapped
// defensively; the action itself runs on idle so an app that quits as a result
// of the click can't free widgets mid-signal.

const LINK_SECTION = "section"
const LINK_SUBMENU = "submenu"
const MAX_DEPTH = 4

function variantStr(v: GLib.Variant | null): string | null {
    if (!v) return null
    try { return v.unpack() as string } catch { return null }
}

export function renderMenuModel(
    model: MenuModelLike | null,
    group: ActionGroupLike | null,
    onClose: () => void,
): Gtk.Box {
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        hexpand: true, width_request: 168,
    })

    const activateLater = (action: string, target: GLib.Variant | null) => {
        const g = group
        if (!g) return
        const dot = action.indexOf(".")
        const name = dot >= 0 ? action.slice(dot + 1) : action
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                if (g.has_action(name)) g.activate_action(name, target)
                else if (g.has_action(action)) g.activate_action(action, target)
            } catch {}
            return GLib.SOURCE_REMOVE
        })
    }

    const safeAttr = (m: MenuModelLike, i: number, name: string): GLib.Variant | null => {
        try { return m.get_item_attribute_value(i, name, null) } catch { return null }
    }
    const safeLink = (m: MenuModelLike, i: number, name: string): MenuModelLike => {
        try { return m.get_item_link(i, name) } catch { return null }
    }

    const separator = () => new Gtk.Separator({ css_classes: ["nidara-menu-sep"], margin_top: 4, margin_bottom: 4 })
    const dimHeader = (label: string) => new Gtk.Label({
        label, halign: Gtk.Align.START, xalign: 0,
        margin_start: 8, margin_top: 4, margin_bottom: 2,
        css_classes: ["nidara-menu-header"],
    })

    const makeRow = (label: string, onClick: () => void): Gtk.Button => {
        const inner = new Gtk.Box({ spacing: 10 })
        inner.append(new Gtk.Label({
            label, halign: Gtk.Align.START, hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 34,
            css_classes: ["nidara-menu-label"],
        }))
        const btn = new Gtk.Button({ child: inner, css_classes: ["nidara-menu-row"], hexpand: true })
        btn.connect("clicked", onClick)
        return btn
    }

    const buildInto = (box: Gtk.Box, m: MenuModelLike, depth: number) => {
        if (depth > MAX_DEPTH || !m) return
        let n = 0
        try { n = m.get_n_items() } catch { return }
        for (let i = 0; i < n; i++) {
            try {
                const section = safeLink(m, i, LINK_SECTION)
                if (section) {
                    if (box.get_first_child()) box.append(separator())
                    buildInto(box, section, depth + 1)
                    continue
                }

                const label = (variantStr(safeAttr(m, i, "label")) || "").replace(/_/g, "").trim()

                const submenu = safeLink(m, i, LINK_SUBMENU)
                if (submenu) {
                    if (box.get_first_child()) box.append(separator())
                    if (label) box.append(dimHeader(label))
                    buildInto(box, submenu, depth + 1)
                    continue
                }

                const action = variantStr(safeAttr(m, i, "action"))
                if (!label && !action) continue   // stray placeholder
                const target = safeAttr(m, i, "target")
                box.append(makeRow(label || "…", () => {
                    onClose()
                    if (action) activateLater(action, target)
                }))
            } catch { /* skip a bad item, never take down the UI */ }
        }
    }

    try { buildInto(root, model, 0) } catch {}
    return root
}

export default renderMenuModel
