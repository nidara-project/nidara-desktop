import { Gtk } from "ags/gtk4"

export type NidaraButtonVariant = "primary" | "danger" | "secondary" | "ghost"
export type NidaraButtonSize = "default" | "compact"

export interface NidaraButtonOpts {
    label?: string
    /** Visual intent (default: "secondary") */
    variant?: NidaraButtonVariant
    /** Size step (default: "default"). ORTHOGONAL to `variant` and to the shape
     *  modifiers — "compact" is one step down the ramp (caption text, tighter
     *  padding, ~24px tall instead of ~32px) and composes with any of them.
     *  Use it for controls that live inside a dense row and must not out-weigh
     *  the row's own text — e.g. the CC audio detail's "set as default" link
     *  (ghost + compact). Do NOT use it to fit a button into a cramped layout:
     *  if the default size doesn't fit, the layout is wrong, not the button. */
    size?: NidaraButtonSize
    /** Pill shape — border-radius 9999px (default: false) */
    pill?: boolean
    /** Square icon-only button — uniform compact size so an icon button sits the same
     *  height as a labelled one in a button cluster (set the icon via set_child). */
    icon?: boolean
    sensitive?: boolean
    valign?: Gtk.Align
    halign?: Gtk.Align
    // No tooltip prop ON PURPOSE: GTK's native tooltip renders in its own
    // GtkTooltipWindow, unreachable by scoped CSS → never themeable. Callers
    // attach the shell's glass tooltip instead (common/Tooltip.attachTooltip;
    // the kit can't do it itself — it stays free of the shell's ThemeManager).
}

/**
 * NidaraButton — the one place where button appearance is defined.
 *
 * CSS lives in _components.scss under `button.nidara-btn`.
 * Never use Adwaita classes (suggested-action, destructive-action, pill,
 * flat) directly in pages — use this function instead.
 *
 * @example
 *   const btn = NidaraButton({ label: "Apply", variant: "primary", pill: true })
 *   btn.connect("clicked", () => { ... })
 */
export function NidaraButton(opts: NidaraButtonOpts = {}): Gtk.Button {
    const { variant = "secondary", size = "default", pill = false, icon = false } = opts

    const cssClasses = ["nidara-btn", `nidara-btn--${variant}`]
    if (size === "compact") cssClasses.push("nidara-btn--compact")
    if (pill) cssClasses.push("nidara-btn--pill")
    if (icon) cssClasses.push("nidara-btn--icon")

    const btn = new Gtk.Button({
        css_classes: cssClasses,
        sensitive: opts.sensitive ?? true,
        valign: opts.valign ?? Gtk.Align.CENTER,
    })

    if (opts.label      !== undefined) btn.set_label(opts.label)
    if (opts.halign     !== undefined) btn.halign = opts.halign

    return btn
}
