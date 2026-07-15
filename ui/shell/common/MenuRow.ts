import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import Icons from "../core/Icons"

// Shared menu-row builders for flat nidara menus (.nidara-menu-row lists in a
// SquircleContainer, never Gtk.Popover — see project_nidara_ui). Used by the
// CC context menu and the bar window menu; NidaraMenu.ts (Gio model renderer)
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
    /** Ellipsize the label instead of letting it widen the menu. Only for
     *  fixed-width menus (the bar window menu, capped at 230); leave off for
     *  content-sized menus (the CC context menu) so they grow to fit labels. */
    ellipsize?: boolean
    /** Extra trailing widget (e.g. a dim hint label). Placed before the check. */
    trailing?: Gtk.Widget
    onClick: () => void
}

const CHECK_KEY = "__nidaraMenuCheck"

export function menuRow(opts: MenuRowOpts): Gtk.Button {
    const inner = new Gtk.Box({ spacing: 10 })
    if (opts.icon) {
        inner.append(new Gtk.Image({ gicon: opts.icon, pixel_size: 15, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER }))
    }
    // A long label (e.g. a group member's window title) can widen the menu. In a
    // fixed-width menu that overflows, so opt into ellipsize (same recipe as
    // menuHeader's ellipsize branch: FILL + hexpand + xalign 0 keeps the text
    // left while max_width_chars caps the natural width). Off by default so a
    // content-sized menu (the CC context menu) still grows to fit its labels
    // instead of collapsing to a single character.
    inner.append(opts.ellipsize
        ? new Gtk.Label({ label: opts.label, halign: Gtk.Align.FILL, hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 1, css_classes: ["nidara-menu-label"] })
        : new Gtk.Label({ label: opts.label, halign: Gtk.Align.START, hexpand: true, css_classes: ["nidara-menu-label"] }))
    if (opts.trailing) inner.append(opts.trailing)
    const check = new Gtk.Image({
        gicon: Icons.check, pixel_size: 15,
        css_classes: ["nd-icon", "accent-label"],
        valign: Gtk.Align.CENTER,
        visible: !!opts.checked,
    })
    inner.append(check)

    const btn = new Gtk.Button({
        child: inner,
        css_classes: ["nidara-menu-row", ...(opts.danger ? ["danger-action"] : [])],
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
    return new Gtk.Separator({ css_classes: ["nidara-menu-sep"], margin_top: 4, margin_bottom: 4 })
}

export function menuHeader(label: string, ellipsize = false): Gtk.Label {
    return new Gtk.Label({
        label,
        halign: ellipsize ? Gtk.Align.FILL : Gtk.Align.START,
        css_classes: ["nidara-menu-header"],
        margin_start: 12, margin_top: 4, margin_bottom: 2,
        // A long window title must not widen the menu (which would stretch the
        // move-to-workspace strip below it). max_width_chars caps the NATURAL
        // width so the title can never push the menu past its fixed width;
        // hexpand fills that width and xalign keeps the text left-aligned.
        ...(ellipsize ? { hexpand: true, xalign: 0, margin_end: 12, ellipsize: 3, max_width_chars: 1 } : {}),
    })
}
