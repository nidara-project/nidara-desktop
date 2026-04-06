import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

const AUTO_HIDE_MS = 3000

/**
 * Icon-only bar widget that expands to show a label on click, then auto-hides.
 * Uses the same structure as fixed bar pills: Gtk.Image + margin_start/end: 16.
 * The Revealer slides in the label to the right of the icon.
 */
export function makeExpandable(opts: {
    getIcon: () => string
    getText: () => string
    onAction?: () => void
    autoHideMs?: number
}): Gtk.Widget {
    const { getIcon, getText, onAction, autoHideMs = AUTO_HIDE_MS } = opts

    // Identical to fixed bar pill structure — Gtk.Image as anchor
    const icon = new Gtk.Image({
        icon_name: getIcon(),
        pixel_size: 16,
        margin_start: 16,
    })

    const label = new Gtk.Label({
        label: "",
        css_classes: ["bar-widget-label"],
        max_width_chars: 14,
        ellipsize: 3,
    })

    const revealer = new Gtk.Revealer({
        transition_type: Gtk.RevealerTransitionType.SLIDE_RIGHT,
        transition_duration: 180,
        reveal_child: false,
    })
    revealer.set_child(label)

    // Box only to host the revealer alongside the icon — no extra sizing
    const box = new Gtk.Box({ spacing: 6 })
    box.append(icon)
    box.append(revealer)

    // Right margin lives on the box so it adjusts with the revealer
    box.margin_end = 16

    let hideTimer: number | null = null
    let expanded = false

    const collapse = () => {
        expanded = false
        revealer.reveal_child = false
    }

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => {
        if (hideTimer) { GLib.source_remove(hideTimer); hideTimer = null }
        if (expanded) {
            collapse()
        } else {
            label.label = getText()
            icon.icon_name = getIcon()
            expanded = true
            revealer.reveal_child = true
            hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, autoHideMs, () => {
                collapse()
                hideTimer = null
                return GLib.SOURCE_REMOVE
            })
        }
        onAction?.()
    })
    box.add_controller(gesture)

    box.connect("unrealize", () => {
        if (hideTimer) { GLib.source_remove(hideTimer); hideTimer = null }
    })

    return box
}

/**
 * Pure icon action button — identical structure to fixed bar pills.
 * Returns a Gtk.Image with a GestureClick attached.
 */
export function makeIconAction(opts: {
    getIcon: () => string
    onAction: () => void
    activeClass?: string
    getActive?: () => boolean
}): Gtk.Widget {
    const { getIcon, onAction, activeClass, getActive } = opts

    const image = new Gtk.Image({
        icon_name: getIcon(),
        pixel_size: 16,
        margin_start: 16,
        margin_end: 16,
    })

    const syncState = () => {
        image.icon_name = getIcon()
        if (activeClass && getActive) {
            if (getActive()) image.add_css_class(activeClass)
            else image.remove_css_class(activeClass)
        }
    }

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => { onAction(); syncState() })
    image.add_controller(gesture)

    syncState()
    return image
}
