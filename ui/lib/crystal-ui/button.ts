import { Gtk } from "ags/gtk4"

export type CrystalButtonVariant = "primary" | "danger" | "secondary" | "ghost"

export interface CrystalButtonOpts {
    label?: string
    /** Visual intent (default: "secondary") */
    variant?: CrystalButtonVariant
    /** Pill shape — border-radius 9999px (default: false) */
    pill?: boolean
    /** Square icon-only button — uniform compact size so an icon button sits the same
     *  height as a labelled one in a button cluster (set the icon via set_child). */
    icon?: boolean
    sensitive?: boolean
    valign?: Gtk.Align
    halign?: Gtk.Align
    tooltip_text?: string
}

/**
 * CrystalButton — the one place where button appearance is defined.
 *
 * CSS lives in _components.scss under `button.crystal-btn`.
 * Never use Adwaita classes (suggested-action, destructive-action, pill,
 * flat) directly in pages — use this function instead.
 *
 * @example
 *   const btn = CrystalButton({ label: "Apply", variant: "primary", pill: true })
 *   btn.connect("clicked", () => { ... })
 */
export function CrystalButton(opts: CrystalButtonOpts = {}): Gtk.Button {
    const { variant = "secondary", pill = false, icon = false } = opts

    const cssClasses = ["crystal-btn", `crystal-btn--${variant}`]
    if (pill) cssClasses.push("crystal-btn--pill")
    if (icon) cssClasses.push("crystal-btn--icon")

    const btn = new Gtk.Button({
        css_classes: cssClasses,
        sensitive: opts.sensitive ?? true,
        valign: opts.valign ?? Gtk.Align.CENTER,
    })

    if (opts.label      !== undefined) btn.set_label(opts.label)
    if (opts.tooltip_text !== undefined) btn.tooltip_text = opts.tooltip_text
    if (opts.halign     !== undefined) btn.halign = opts.halign

    return btn
}
