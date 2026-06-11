import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import Icons from "../../core/Icons"

// Shared menu-row builders for flat crystal menus (.crystal-menu-row lists in a
// SquircleContainer, never Gtk.Popover — see project_crystal_ui). Used by the
// CC context menu and the bar window menu; CrystalMenu.ts (Gio model renderer)
// and the bar overflow list keep their own shapes.

export interface MenuRowOpts {
    label: string
    /** A GIcon as produced by core/Icons (the GI typings don't export Gio.Icon). */
    icon?: Gio.FileIcon
    /** Shows a trailing accent check. The check widget always exists (hidden when
     *  false/undefined) so setRowChecked can flip it after an async state read. */
    checked?: boolean
    sensitive?: boolean
    danger?: boolean
    /** Extra trailing widget (e.g. a dim hint label). Placed before the check. */
    trailing?: Gtk.Widget
    onClick: () => void
}

const CHECK_KEY = "__crystalMenuCheck"

export function menuRow(opts: MenuRowOpts): Gtk.Button {
    const inner = new Gtk.Box({ spacing: 10 })
    if (opts.icon) {
        inner.append(new Gtk.Image({ gicon: opts.icon, pixel_size: 15, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
    }
    inner.append(new Gtk.Label({ label: opts.label, halign: Gtk.Align.START, hexpand: true, css_classes: ["crystal-menu-label"] }))
    if (opts.trailing) inner.append(opts.trailing)
    const check = new Gtk.Image({
        gicon: Icons.check, pixel_size: 15,
        css_classes: ["cs-icon", "accent-label"],
        valign: Gtk.Align.CENTER,
        visible: !!opts.checked,
    })
    inner.append(check)

    const btn = new Gtk.Button({
        child: inner,
        css_classes: ["crystal-menu-row", ...(opts.danger ? ["danger-action"] : [])],
        hexpand: true,
        sensitive: opts.sensitive ?? true,
    })
    ;(btn as any)[CHECK_KEY] = check
    btn.connect("clicked", opts.onClick)
    return btn
}

/** Flip a row's check after the fact (async one-shot state reads). */
export function setRowChecked(row: Gtk.Button, checked: boolean) {
    const check = (row as any)[CHECK_KEY] as Gtk.Image | undefined
    if (check) check.visible = checked
}

export function menuSeparator(): Gtk.Separator {
    return new Gtk.Separator({ css_classes: ["crystal-menu-sep"], margin_top: 4, margin_bottom: 4 })
}

export function menuHeader(label: string): Gtk.Label {
    return new Gtk.Label({
        label,
        halign: Gtk.Align.START,
        css_classes: ["crystal-menu-header"],
        margin_start: 12, margin_top: 4, margin_bottom: 2,
    })
}
