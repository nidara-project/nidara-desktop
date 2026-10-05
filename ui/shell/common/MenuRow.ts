import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { uiIcon } from "../core/Icons"

// Shared menu-row builders for flat nidara menus (.nidara-menu-row lists in a
// SquircleContainer, never Gtk.Popover — see project_nidara_ui). Used by the
// CC context menu, the bar window menu, the bar overflow list, and clipboard/media widgets;
// NidaraMenu.ts renders Gio menu models.

export interface MenuRowOpts {
    label: string
    /** A GIcon as produced by core/Icons (the GI typings don't export Gio.Icon). */
    icon?: Gio.FileIcon
    /** The icon is full-color app art (desktop-entry GIcon) — skip `nd-icon`,
     *  which paints its image --nidara-text and would flatten the artwork to one
     *  colour. (It was an invert(1) before #587, which turned it negative.) */
    appIcon?: boolean
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
    /** Centre the icon+label instead of left-aligning them. For a row that is an
     *  ACTION on the whole list rather than one of its items — a footer like "Clear
     *  history". Left alignment reads as "another entry"; centred reads as a button.
     *  Not for rows inside a menu's item column: they must share one text axis. */
    center?: boolean
    onClick: () => void
}

const CHECK_KEY = "__nidaraMenuCheck"

export function menuRow(opts: MenuRowOpts): Gtk.Button {
    const inner = new Gtk.Box({ spacing: 12, halign: opts.center ? Gtk.Align.CENTER : Gtk.Align.FILL, hexpand: true })
    if (opts.icon) {
        inner.append(new Gtk.Image({ gicon: opts.icon, pixel_size: 15, css_classes: opts.appIcon ? [] : ["nd-icon"], valign: Gtk.Align.CENTER }))
    }
    // A long label (e.g. a group member's window title) can widen the menu. In a
    // fixed-width menu that overflows, so opt into ellipsize (same recipe as
    // menuHeader's ellipsize branch: FILL + hexpand + xalign 0 keeps the text
    // left while max_width_chars caps the natural width). Off by default so a
    // content-sized menu (the CC context menu) still grows to fit its labels
    // instead of collapsing to a single character.
    inner.append(opts.center
        ? new Gtk.Label({ label: opts.label, halign: Gtk.Align.CENTER, css_classes: ["nidara-menu-label"] })
        : opts.ellipsize
            ? new Gtk.Label({ label: opts.label, halign: Gtk.Align.FILL, hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 1, css_classes: ["nidara-menu-label"] })
            : new Gtk.Label({ label: opts.label, halign: Gtk.Align.START, hexpand: true, css_classes: ["nidara-menu-label"] }))
    if (opts.trailing) inner.append(opts.trailing)
    // `nd-icon` ONLY. It used to carry `accent-label` too, meaning to tint the tick
    // accent — which a Gtk.Image did not obey then, because an nd-icon was monochrome
    // and driven by `-gtk-icon-filter: invert(1)`. Since #587 the glyphs are symbolic
    // and `color` DOES reach them, so that tint is now possible; it is still not what
    // this row wants, for the reason power.ts gives. The one part of that
    // class that DID apply was the rest of it: `.accent-label` is the audio detail's
    // "Default" BADGE — pill background, radius and padding — so inside
    // `.nidara-detail-panel` every checked menu row drew an accent pill behind its tick,
    // and nowhere else. User-caught in the CC's media source selector 2026-08-10,
    // against the island's copy of the same menu, which never matched that rule.
    const check = new Gtk.Image({
        gicon: uiIcon("nd-emblem-default"), pixel_size: 15,
        css_classes: ["nd-icon"],
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

/**
 * A row that opens IN PLACE onto the rows under it — "Move to Desktop ›" in the bar's
 * window menu. Our menus open in the bar's shared expansion capsule, which has no
 * nested-submenu machinery and no room beside it for one; the rows slide down inside the
 * same panel instead, and the panel grows with them (it re-stamps its regions on every
 * allocation). The chevron turns from end to down while open.
 *
 * `build` runs on every opening, so the rows say what is true when you look, and the
 * GTK default slide is the Settings "Advanced" disclosure's: one motion for one gesture.
 */
export function menuDisclosure(opts: { label: string; build: () => Gtk.Widget[] }): Gtk.Widget {
    const chevron = new Gtk.Image({ gicon: uiIcon("nd-pan-end"), pixel_size: 15, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER })
    const inner = new Gtk.Box({ spacing: 12, hexpand: true })
    inner.append(new Gtk.Label({ label: opts.label, halign: Gtk.Align.FILL, hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 1, css_classes: ["nidara-menu-label"] }))
    inner.append(chevron)
    const head = new Gtk.Button({ child: inner, css_classes: ["nidara-menu-row"], hexpand: true })

    // Indented: the rows belong to the one above them, and nothing else on the panel says so.
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 12 })
    const revealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN, reveal_child: false, child: body })

    head.connect("clicked", () => {
        const open = !revealer.reveal_child
        if (open) {
            let c = body.get_first_child()
            while (c) { const n = c.get_next_sibling(); body.remove(c); c = n }
            for (const row of opts.build()) body.append(row)
        }
        chevron.gicon = uiIcon(open ? "nd-pan-down" : "nd-pan-end")
        revealer.reveal_child = open
    })

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    box.append(head)
    box.append(revealer)
    return box
}
