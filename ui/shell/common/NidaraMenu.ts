import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Icons from "../core/Icons"

// MenuModelLike / ActionGroupLike aren't surfaced by the @girs stub here — alias
// them. The three callers pass a real Gio.MenuModel: the dock and app grid build
// theirs from desktop-entry actions, and the tray's comes from `core/dbusmenu.ts`.
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

function variantBool(v: GLib.Variant | null): boolean | null {
    if (!v) return null
    try {
        const val = v.unpack()
        if (typeof val === "boolean") return val
        if (typeof val === "number") return val === 1
        return null
    } catch { return null }
}

function getIconFromModel(
    safeAttr: (m: MenuModelLike, i: number, name: string) => GLib.Variant | null,
    m: MenuModelLike,
    i: number,
): { gicon?: any; iconName?: string } | null {
    const iconVar = safeAttr(m, i, "icon")
    if (iconVar) {
        try {
            const gicon = Gio.Icon.deserialize(iconVar)
            if (gicon) return { gicon }
        } catch {}
        try {
            const str = iconVar.unpack()
            if (typeof str === "string" && str) return { iconName: str }
        } catch {}
    }
    const iconNameVar = safeAttr(m, i, "icon-name")
    if (iconNameVar) {
        try {
            const str = iconNameVar.unpack()
            if (typeof str === "string" && str) return { iconName: str }
        } catch {}
    }
    return null
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

    const makeRow = (
        label: string,
        onClick: () => void,
        opts: { iconInfo?: { gicon?: any; iconName?: string } | null; checked?: boolean; sensitive?: boolean } = {}
    ): Gtk.Button => {
        const inner = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
        if (opts.iconInfo?.gicon) {
            inner.append(new Gtk.Image({ gicon: opts.iconInfo.gicon, pixel_size: 15, valign: Gtk.Align.CENTER }))
        } else if (opts.iconInfo?.iconName) {
            inner.append(new Gtk.Image({ icon_name: opts.iconInfo.iconName, pixel_size: 15, valign: Gtk.Align.CENTER }))
        }
        inner.append(new Gtk.Label({
            label, halign: Gtk.Align.START, hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 34,
            css_classes: ["nidara-menu-label"],
        }))
        if (opts.checked) {
            inner.append(new Gtk.Image({
                gicon: Icons.check,
                pixel_size: 15,
                css_classes: ["nd-icon"],
                valign: Gtk.Align.CENTER,
            }))
        }
        const btn = new Gtk.Button({
            child: inner,
            css_classes: ["nidara-menu-row"],
            hexpand: true,
            sensitive: opts.sensitive ?? true,
        })
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
                    // A section can carry a label (g_menu_append_section(label, …)) —
                    // render it as a dim header (e.g. the dock menu's app-name title).
                    const secLabel = (variantStr(safeAttr(m, i, "label")) || "").replace(/_/g, "").trim()
                    if (secLabel) box.append(dimHeader(secLabel))
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

                const iconInfo = getIconFromModel(safeAttr, m, i)
                const toggleType = variantStr(safeAttr(m, i, "toggle-type"))
                const toggleState = variantBool(safeAttr(m, i, "toggle-state"))
                const isChecked = (toggleType === "checkmark" || toggleType === "radio") && toggleState === true

                const enabledAttr = variantBool(safeAttr(m, i, "enabled")) ?? variantBool(safeAttr(m, i, "sensitive"))

                box.append(makeRow(label || "…", () => {
                    onClose()
                    if (action) activateLater(action, target)
                }, {
                    iconInfo,
                    checked: isChecked,
                    sensitive: enabledAttr ?? true,
                }))
            } catch { /* skip a bad item, never take down the UI */ }
        }
    }

    try { buildInto(root, model, 0) } catch {}
    return root
}

export default renderMenuModel
