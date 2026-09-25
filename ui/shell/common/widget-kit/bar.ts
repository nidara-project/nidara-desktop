// The BAR half of the widget vocabulary — what a widget's pill looks like in the
// bar, as opposed to its tile in the Control Centre (tile.ts) or the room a panel
// opens for it (panel.ts).
//
// It lived in `widgets/bar-helpers.ts`, the ONE non-widget file the registry codegen
// had to grandfather past its own "widgets/ is a widgets-only directory" rule. With
// the kit in place there is nowhere else it should be, and the codegen has no
// exceptions left.
//
// Leaf module — no shell imports. See panel.ts for the cycle that crashes the boot.
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

function setIcon(img: Gtk.Image, icon: Gio.FileIcon | string) {
    if (typeof icon === "string") img.icon_name = icon
    else img.gicon = icon
}

const AUTO_HIDE_MS = 3000

/** The air on each side of a bar capsule's content — an icon-only pill is
 *  PAD + 16 + PAD wide. Every bar capsule uses it (the widgets' pills, search, CC,
 *  the overflow arrow, the clock, the window title, the tray, the island's compact
 *  forms), so they stay one family. 16 until 2026-09-25: the capsules grew to 36px
 *  tall and the gap between them went 8 → 6 (surfaces/bar/capsule.ts); the owner
 *  moved those 2px inside, to each side of the icon. */
export const BAR_PILL_PAD = 18

/**
 * Icon-only bar widget that expands to show a label on click, then auto-hides.
 * Uses the same structure as fixed bar pills: Gtk.Image + margin_start/end: BAR_PILL_PAD.
 * The Revealer slides in the label to the right of the icon.
 */
export function makeBarExpandable(opts: {
    getIcon: () => Gio.FileIcon | string
    getText: () => string
    onAction?: () => void
    autoHideMs?: number
}): Gtk.Widget {
    const { getIcon, getText, onAction, autoHideMs = AUTO_HIDE_MS } = opts

    // Identical to fixed bar pill structure — Gtk.Image as anchor
    const icon = new Gtk.Image({ pixel_size: 16, margin_start: BAR_PILL_PAD, css_classes: ["nd-icon"] })
    setIcon(icon, getIcon())

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
    const box = new Gtk.Box({ spacing: 8 })
    box.append(icon)
    box.append(revealer)

    // Right margin lives on the box so it adjusts with the revealer
    box.margin_end = BAR_PILL_PAD

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
            setIcon(icon, getIcon())
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
export function makeBarIcon(opts: {
    getIcon: () => Gio.FileIcon | string
    onAction: () => void
    activeClass?: string
    getActive?: () => boolean
    subscribe?: (sync: () => void) => () => void
}): Gtk.Widget {
    const { getIcon, onAction, activeClass, getActive, subscribe } = opts

    const image = new Gtk.Image({ pixel_size: 16, margin_start: BAR_PILL_PAD, margin_end: BAR_PILL_PAD, css_classes: ["nd-icon"] })
    setIcon(image, getIcon())

    const syncState = () => {
        setIcon(image, getIcon())
        if (activeClass && getActive) {
            if (getActive()) image.add_css_class(activeClass)
            else image.remove_css_class(activeClass)
        }
    }

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => { onAction(); syncState() })
    image.add_controller(gesture)

    if (subscribe) {
        const cleanup = subscribe(syncState)
        image.connect("unrealize", cleanup)
    }

    syncState()
    return image
}
