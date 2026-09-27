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

/** What a bar icon DOES, for the keyboard. The icons below take their click through a
 *  GestureClick on an image or a box — nothing a key can reach — so each registers
 *  the same action here, and the bar's item (surfaces/bar/capsule.ts) runs it on
 *  Enter/Space/↓. A WeakMap, not a property: the widget goes, its entry goes. */
const keyActions = new WeakMap<Gtk.Widget, () => void>()
export const barKeyAction = (w: Gtk.Widget): (() => void) | undefined => keyActions.get(w)

/** The air on each side of a STANDALONE bar capsule's content — an icon-only pill
 *  is PAD + 16 + PAD = 48 wide. Since 2026-09-26 that is only the island's compact
 *  forms: everything else in the bar is an ITEM inside a group (BAR_ITEM_PAD). On the
 *  4px scale with the rest of the bar's geometry (surfaces/bar/capsule.ts). */
export const BAR_PILL_PAD = 16

/** The air on each side of a bar ITEM's content — an icon-only item is
 *  8 + 18 + 8 = 34 wide, and its hover/open pill is exactly that wide. Every widget's
 *  bar content carries it (and so do search, the CC, the `»`, the clock, the window
 *  title, the tray), because the item draws its pill round whatever the content
 *  measures: the widget owns its air, the group owns none. The bar's groups:
 *  surfaces/bar/capsule.ts (barGroup / barItem). */
export const BAR_ITEM_PAD = 8

/** The size of every icon IN THE BAR — the widgets' bar content, search, the CC,
 *  the `»`, the tray. 18, not the 16 it was until 2026-09-27: the owner found them
 *  slightly small, and the reference agreed on is macOS with our CAPSULE as
 *  its whole bar (the air above the capsule is ours alone). macOS draws 16 pt
 *  icons in a 24 pt bar; our visible glass is 28 px (BAR_CAPSULE_H 32 minus the
 *  2 px edge each side), and 16 × 28/24 ≈ 18.7. Against the hover pill it comes
 *  out the same: Apple's 16 in ~22 is 73 %, and 73 % of our 24 px pill is 17.5.
 *  The bar's HEIGHT does not move with this — an 18 px icon sits in the 24 px pill
 *  with 3 px above and below; each icon item gets 2 px wider (PAD + 18 + PAD). */
export const BAR_ICON_SIZE = 18

/**
 * Icon-only bar widget that expands to show a label on click, then auto-hides.
 * Uses the same structure as fixed bar items: Gtk.Image + margin_start/end: BAR_ITEM_PAD.
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
    const icon = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
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
    box.margin_end = BAR_ITEM_PAD

    let hideTimer: number | null = null
    let expanded = false

    const collapse = () => {
        expanded = false
        revealer.reveal_child = false
    }

    const act = () => {
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
    }
    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", act)
    box.add_controller(gesture)
    keyActions.set(box, act)

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

    const image = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
    setIcon(image, getIcon())

    const syncState = () => {
        setIcon(image, getIcon())
        if (activeClass && getActive) {
            if (getActive()) image.add_css_class(activeClass)
            else image.remove_css_class(activeClass)
        }
    }

    const act = () => { onAction(); syncState() }
    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", act)
    image.add_controller(gesture)
    keyActions.set(image, act)

    if (subscribe) {
        const cleanup = subscribe(syncState)
        image.connect("unrealize", cleanup)
    }

    syncState()
    return image
}
