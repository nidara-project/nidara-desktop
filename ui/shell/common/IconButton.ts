import Gtk from "gi://Gtk?version=4.0"
import { NidaraCircleButton, type NidaraCircleVariant } from "../../lib/nidara-kit"
import { attachTooltip } from "./Tooltip"

/** Re-exported from the kit: this file no longer owns the vocabulary. */
export type IconBtnVariant = NidaraCircleVariant

export interface IconButtonProps {
    // A GIcon (as produced by core/Icons). Typed loosely — the GI typings don't export Gio.Icon.
    icon: any
    /**
     * Icon pixel size. The button sizes itself from this + the CSS padding (like the
     * Settings close button), so the glyph renders crisp — NOT scaled by set_size_request.
     * Default 14.
     */
    iconSize?: number
    /** Destructive intent ("danger", the default) vs plain ("neutral"). ⚠️ BOTH
     *  hover the same neutral grey today — the red wash was declined on
     *  2026-08-26 (it spends the DE's red budget on the most routine click there
     *  is). The class is still emitted, so the intent is recorded and one CSS
     *  rule would turn it on again; nothing reads it otherwise. */
    variant?: IconBtnVariant
    onClick?: () => void
    /** Shown as the Nidara glass tooltip (attachTooltip), NOT GTK's native one —
     *  same bubble as the dock/tray/app-grid. */
    tooltip?: string
    /** Tooltip skin: true (default) = shell chrome (pinned appearance — bar/dock/
     *  overlay contexts); false = app-mode (follows the system mode — pass this
     *  from real windows like Settings/About). Same convention as
     *  SquircleContainer's `chrome`. */
    tooltipChrome?: boolean
    cssClasses?: string[]
    halign?: Gtk.Align
    valign?: Gtk.Align
    /**
     * Use a CAPTURE-phase GestureClick (claims the event) instead of "clicked", so the
     * press doesn't propagate to a clickable parent (e.g. a notification card's tap).
     */
    captureClick?: boolean
}

/**
 * The shell's round glass icon button — `NidaraCircleButton` plus the two things
 * only the shell can add.
 *
 * ⚠️ It does NOT build a button any more (2026-08-26). The widget and its
 * `.nidara-circle-btn` rule moved to `ui/lib/nidara-kit/` when the installer
 * needed the same control: a fourth bundle asking for a close button is exactly
 * the moment a shell-local "single source of truth" stops being one. What stays
 * here is what the kit cannot reach — `attachTooltip` (the glass bubble, which
 * needs the shell's ThemeManager) and the capture-phase click.
 */
export default function IconButton(props: IconButtonProps): Gtk.Button {
    const btn = NidaraCircleButton({
        icon: props.icon,
        iconSize: props.iconSize,
        variant: props.variant,
        halign: props.halign,
        valign: props.valign,
        cssClasses: props.cssClasses,
        // A capture-phase click claims the event before the parent sees it, which
        // "clicked" cannot do — so that variant is wired below instead.
        onClick: props.captureClick ? undefined : props.onClick,
    })

    // The one Nidara tooltip (glass bubble), never GTK's native tooltip_text —
    // native tooltips render Adwaita chrome that ignores the design system.
    // attachTooltip auto-cleans on the button's destroy.
    if (props.tooltip)
        attachTooltip(btn, props.tooltip, { chrome: props.tooltipChrome ?? true })

    if (props.captureClick && props.onClick) {
        const g = new Gtk.GestureClick()
        g.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        g.connect("pressed", (gesture) => { gesture.set_state(Gtk.EventSequenceState.CLAIMED); props.onClick!() })
        btn.add_controller(g)
    }

    return btn
}
