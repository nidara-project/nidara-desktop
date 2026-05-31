import { Gtk } from "ags/gtk4"

export type IconBtnVariant = "danger" | "neutral"

export interface IconButtonProps {
    // A GIcon (as produced by core/Icons). Typed loosely — the GI typings don't export Gio.Icon.
    icon: any
    /**
     * Icon pixel size. The button sizes itself from this + the CSS padding (like the
     * Settings close button), so the glyph renders crisp — NOT scaled by set_size_request.
     * Default 14.
     */
    iconSize?: number
    /** Hover color: "danger" → red, "neutral" → grey. Default "danger". */
    variant?: IconBtnVariant
    onClick?: () => void
    tooltip?: string
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
 * Shared round glass icon button — the single source of truth for close/remove/collapse
 * controls across the shell. Neutral glass at rest; "danger" variant turns red on hover,
 * "neutral" stays grey. The button hugs its icon (icon + CSS padding); no set_size_request,
 * so the glyph stays crisp and the round fill is perfectly centred on it.
 */
export default function IconButton(props: IconButtonProps): Gtk.Button {
    const iconSize = props.iconSize ?? 14
    const variant = props.variant ?? "danger"

    const btn = new Gtk.Button({
        child: new Gtk.Image({ gicon: props.icon, pixel_size: iconSize, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-circle-btn", `is-${variant}`, ...(props.cssClasses ?? [])],
        halign: props.halign ?? Gtk.Align.CENTER,
        valign: props.valign ?? Gtk.Align.CENTER,
        tooltip_text: props.tooltip ?? "",
    })

    if (props.onClick) {
        if (props.captureClick) {
            const g = new Gtk.GestureClick()
            g.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            g.connect("pressed", (gesture) => { gesture.set_state(Gtk.EventSequenceState.CLAIMED); props.onClick!() })
            btn.add_controller(g)
        } else {
            btn.connect("clicked", () => props.onClick!())
        }
    }

    return btn
}
