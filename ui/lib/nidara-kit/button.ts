import Gtk from "gi://Gtk?version=4.0"

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

export type NidaraCircleVariant = "danger" | "neutral"

export interface NidaraCircleButtonOpts {
    /** A GIcon (as produced by the shell's core/Icons or by lib/icons.ndIcon).
     *  Typed loosely — the GI typings don't export Gio.Icon. */
    icon?: any
    /** Theme icon name, used when `icon` is null (ndIcon returns null when the
     *  shipped asset tree is missing). */
    iconName?: string
    /**
     * Icon pixel size. The button sizes itself from this + the CSS padding, so the
     * glyph renders crisp — NOT scaled by set_size_request. Default 14.
     */
    iconSize?: number
    /** Destructive intent ("danger", the default) vs plain ("neutral"). ⚠️ BOTH
     *  hover the same neutral grey today — the red wash was declined on
     *  2026-08-26 (it spends the DE's red budget on the most routine click there
     *  is). The class is still emitted, so the intent is recorded and one CSS
     *  rule would turn it on again; nothing reads it otherwise. */
    variant?: NidaraCircleVariant
    sensitive?: boolean
    valign?: Gtk.Align
    halign?: Gtk.Align
    /** Extra classes, appended after the kit's own. */
    cssClasses?: string[]
    onClick?: () => void
}

/**
 * NidaraCircleButton — the round glass icon button: close, remove, collapse.
 *
 * One implementation for every bundle. The shell's `common/IconButton.ts` is a
 * thin wrapper that adds the two things only the shell can provide (the glass
 * tooltip, and the capture-phase click that stops a clickable parent from also
 * firing); it does NOT build its own button any more.
 *
 * ⚠️ A shipped Nidara icon is a Lucide SVG — it renders BLACK and only becomes
 * white through the `.nd-icon` class, which is why one is added here. A bundle
 * whose stylesheet has no `.nd-icon` rule gets a black glyph on dark glass, i.e.
 * an invisible button. The shell has it in `_reset.scss`, the greeter/lock and
 * the installer in their own sheets.
 */
export function NidaraCircleButton(opts: NidaraCircleButtonOpts): Gtk.Button {
    const iconSize = opts.iconSize ?? 14
    const variant = opts.variant ?? "danger"

    // `nd-icon` rides along only on the SHIPPED icon: a theme fallback is a
    // symbolic icon that already follows the CSS colour, and inverting it would
    // paint it the wrong way round. Same rule as lib/icons.ndImage.
    const child = opts.icon
        ? new Gtk.Image({ gicon: opts.icon, pixel_size: iconSize, css_classes: ["nd-icon"] })
        : new Gtk.Image({ icon_name: opts.iconName ?? "window-close-symbolic", pixel_size: iconSize })

    const btn = new Gtk.Button({
        child,
        css_classes: ["nidara-circle-btn", `is-${variant}`, ...(opts.cssClasses ?? [])],
        valign: opts.valign ?? Gtk.Align.CENTER,
        halign: opts.halign ?? Gtk.Align.CENTER,
        sensitive: opts.sensitive ?? true,
    })
    if (opts.onClick) btn.connect("clicked", opts.onClick)
    return btn
}
