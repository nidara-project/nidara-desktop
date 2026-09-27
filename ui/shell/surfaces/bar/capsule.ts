import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import status from "../../core/Status"
import Theme from "../../core/ThemeManager"
import { safeDisconnect } from "../../core/signals"
import SquircleContainer, { GLASS_SHADOW } from "../../common/SquircleContainer"
import { attachTooltip, type NidaraTooltipHandle, type NidaraTooltipOpts, type NidaraTooltipText } from "../../../lib/nidara-kit"
import { GLASS_SPECULAR, GLASS_TINT, GLASS_STATE_MIX } from "../../../lib/nidara-kit/platform/tokens"
import { cairoDraw } from "../../../lib/nidara-kit/platform/cairo-draw"
import { barKeyAction } from "../../common/widget-kit"

// Shared bar-capsule edge: a faint white inner border. It no longer changes on
// hover: the capsules pass `hoverLift` (the glass lifts a little) and `barOpen`
// (the glass shows the panel is open) — see GLASS_STATE_MIX. Used by Bar, Tray
// and AppTitle.
export const CAPSULE_BORDER = { r: 1, g: 1, b: 1, a: 0.2 }

// The bar's geometry, on the design system's 4px scale (owner, 2026-09-25):
//   4 above a capsule · 32 capsule (8 + a 16px icon + 8) · 8 to the windows below
//   (Hyprland's gaps_out) · 4 between capsules · 8 at the two ends (Bar.tsx BAR_MARGIN).
// Inside a GROUP (barGroup below, 2026-09-26): 4 from the glass allocation to the
// first item · each item its content + 8 a side (BAR_ITEM_PAD, common/widget-kit/bar.ts),
// items touching · the hover pill 4 in from the top and bottom (BAR_VEIL_INSET).

// The strip the bar reserves (its exclusive zone): the capsule plus the 4px above it.
// The side dock's window height is the monitor minus this, so it lives here and not
// in Bar.tsx. 40 until 2026-09-25, with the capsule 8px from the edge.
export const BAR_H = 36

// A bar capsule's height. NOT set anywhere as a size: the row is BAR_H tall and
// `.bar-centerbox` gives it `margin-top: 4px`, which GTK takes out of the row's own
// height_request — so what is left for the capsule is 32. It lives here for the ones
// that must MATCH it: the island's indicator chips are this wide so that `perfect`'s
// h/2 radius makes them circles. Change BAR_H, the CSS margin and this together.
export const BAR_CAPSULE_H = 32

// The gap between two pieces of bar glass that sit side by side — since the groups
// (2026-09-26) that is only the island's row: its capsule and its chips. Inside a
// group items touch, and nothing else stands next to another capsule. The two
// ENDS stay at 8 (Bar.tsx BAR_MARGIN): that is Hyprland's gaps_out, so the system
// menu lines up with the windows' left edge. (8 until 2026-09-25.)
export const BAR_GAP = 4

// ── Groups and items (owner, 2026-09-26) ────────────────────────────────────
// The bar is THREE pieces of glass, not one per icon: the left group (system menu +
// window title), the island (its own surface, its chips still apart), and the right
// group (the `»`, the widgets, the tray, search, the CC, the clock). The group's glass
// never changes; what marks hover and open is a pill INSIDE it, under the one item —
// the way macOS's menu bar, GNOME's top bar and a segmented control all do it.

// From the group's allocation to its first/last item. The glass itself is painted
// GLASS_INSET (2) in from the allocation, so the end items' pills sit 2px inside the
// visible edge — the same 2px they keep from the top and bottom (BAR_VEIL_INSET).
export const BAR_GROUP_PAD = 4

// The hover/open pill's distance from the item's top and bottom: 32 − 2×4 = 24 tall,
// radius 12 — concentric with the glass, which is 28 visible (radius 14) at 2px in.
export const BAR_VEIL_INSET = 4

/** One piece of bar glass holding a row of items. Append items to `box`. */
export function barGroup(): { widget: Gtk.Widget, box: Gtk.Box } {
    const box = new Gtk.Box({ margin_start: BAR_GROUP_PAD, margin_end: BAR_GROUP_PAD })
    const widget = SquircleContainer({
        child: box, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar",
        shadow: GLASS_SHADOW, borderColor: CAPSULE_BORDER, perfect: true,
    })
    return { widget, box }
}

export interface BarItemOpts {
    child: Gtk.Widget
    /** On PRESS, like the capsules were. Widgets that decide on release add their own gesture. */
    onClick?: () => void
    /** From `barOpen(…)`: the item's pill stays up while its panel is down. */
    getOpen?: () => boolean
    watchOpen?: (cb: () => void) => (() => void)
    /** What Enter/Space/↓ does when the item holds the keyboard focus (Super+Ctrl+B).
     *  Defaults to `onClick`, then to the kit icon's own action (`barKeyAction`); an
     *  item with none of the three is not a keyboard stop — its content is, if it is
     *  a button (a tray icon), or nothing is. */
    onKey?: () => void
}

// ── Edit mode (Status.bar_edit_mode) ────────────────────────────────────────
// While the right group is being reordered every item shows its pill at the hover
// alpha — "these can move" — and the SELECTED one (the last pressed; the arrow keys
// move it) at the open alpha. An item's own click does nothing meanwhile.
let editSelected: Gtk.Widget | null = null
const editListeners = new Set<() => void>()
export function setBarEditSelected(w: Gtk.Widget | null) {
    if (editSelected === w) return
    editSelected = w
    for (const cb of editListeners) cb()
}
export const barEditSelected = () => editSelected
status.connect("notify::bar-edit-mode", () => {
    if (!status.bar_edit_mode) editSelected = null
    for (const cb of editListeners) cb()
})

/** An item in a bar group: its content over a Cairo pill that shows only on hover
 *  (`GLASS_STATE_MIX.hover`) or while its panel is open (`.open`, which wins). The
 *  pill is the item's whole width — content + BAR_ITEM_PAD a side — and 24 tall; the
 *  whole 32px column is the hit target. Same ink and alphas the capsule's veil used,
 *  painted over the group's glass instead of folded into a capsule's own fill: the
 *  same pixels. */
const itemKeys = new WeakMap<Gtk.Widget, () => void>()
/** Make a bar item a keyboard stop whose Enter/Space/↓ runs `run` — for an item whose
 *  action only exists after it is built (AppTitle's window menu). */
export function setBarItemKey(item: Gtk.Widget, run: () => void) {
    itemKeys.set(item, run)
    item.focusable = true
}

export function barItem({ child, onClick, getOpen, watchOpen, onKey }: BarItemOpts): Gtk.Widget {
    // The veil EXPANDS and the item does NOT, both on purpose. A Gtk.Grid hands its
    // spare room only to rows and columns that expand: without the veil's expand the
    // cell stays at the content's natural 16px, at the TOP of the 32px item, and the
    // icons sit above the glass (caught live 2026-09-26). And an unset expand on the
    // item would be computed from that child, so every item — and the group — would
    // fill the flank: hence the item's explicit false.
    const item = new Gtk.Grid({ css_classes: ["bar-item"], hexpand: false, vexpand: false })
    // The veil's BOX is the pill (BAR_VEIL_INSET above and below, the item's full
    // width), not the whole item: the keyboard ring is GTK's outline round this box
    // (`.bar-item:focus-visible > .bar-item-veil`, _bar.scss), so the box has to be
    // the shape the ring should follow — the hover pill, not the 32px square.
    const veil = new Gtk.DrawingArea({
        hexpand: true, vexpand: true, can_target: false, css_classes: ["bar-item-veil"],
        margin_top: BAR_VEIL_INSET, margin_bottom: BAR_VEIL_INSET,
    })
    let hovered = false

    veil.set_draw_func(cairoDraw((_, cr, w, h) => {
        const mix = status.bar_edit_mode
            ? (editSelected === item ? GLASS_STATE_MIX.open : GLASS_STATE_MIX.hover)
            : getOpen?.() ? GLASS_STATE_MIX.open : hovered ? GLASS_STATE_MIX.hover : null
        const vh = h
        if (!mix || w <= 0 || vh <= 0) return
        const dark = Theme.chromeIsDark
        const ink = dark ? GLASS_SPECULAR : GLASS_TINT.dark
        const r = Math.min(vh, w) / 2
        const top = 0, bottom = vh
        cr.newSubPath()
        cr.arc(w - r, top + r, r, -Math.PI / 2, 0)
        cr.arc(w - r, bottom - r, r, 0, Math.PI / 2)
        cr.arc(r, bottom - r, r, Math.PI / 2, Math.PI)
        cr.arc(r, top + r, r, Math.PI, 1.5 * Math.PI)
        cr.closePath()
        cr.setSourceRGBA(ink.r, ink.g, ink.b, dark ? mix.dark : mix.light)
        cr.fill()
    }))
    item.attach(veil, 0, 0, 1, 1)
    item.attach(child, 0, 0, 1, 1)

    // Super+Ctrl+B: the item is a keyboard stop when it has something to DO.
    const act = onKey ?? onClick ?? barKeyAction(child)
    if (act) setBarItemKey(item, act)
    const keys = new Gtk.EventControllerKey()
    keys.connect("key-pressed", (_c: any, keyval: number) => {
        const run = itemKeys.get(item)
        if (!run || !item.is_focus() || status.bar_edit_mode) return false
        if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter && keyval !== Gdk.KEY_space
            && keyval !== Gdk.KEY_KP_Space && keyval !== Gdk.KEY_Down) return false
        run()
        return true
    })
    item.add_controller(keys)

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { hovered = true; veil.queue_draw() })
    motion.connect("leave", () => { hovered = false; veil.queue_draw() })
    item.add_controller(motion)

    if (onClick) {
        const click = new Gtk.GestureClick()
        click.connect("pressed", () => { if (!status.bar_edit_mode) onClick() })
        item.add_controller(click)
    }

    // Subscriptions live while MAPPED, not from construction: the widget pills are
    // rebuilt on every layout pass, and a handler taken at build time and dropped on
    // `unrealize` (the capsule's way) is never taken again after a re-realize.
    let unwatch: (() => void) | null = null
    let themeId = 0
    item.connect("map", () => {
        const redraw = () => veil.queue_draw()
        const offOpen = watchOpen?.(redraw)
        editListeners.add(redraw)
        unwatch = () => { offOpen?.(); editListeners.delete(redraw) }
        themeId = Theme.connect("changed", redraw)
        veil.queue_draw()
    })
    item.connect("unmap", () => {
        unwatch?.(); unwatch = null
        if (themeId) { safeDisconnect(Theme, themeId); themeId = 0 }
        hovered = false
    })
    return item
}

// Whether a panel that drops from the bar is open — its own expansion panel (a
// widget's, a tray menu), or the CC / NC / system menu, which all sit under the
// bar's right and left ends.
export const barPanelOpen = () =>
    status.bar_expanded_id !== "" || status.cc_open || status.nc_open || status.system_menu_open

// The bar's tooltip: the kit's, plus the dock's rule — none while a panel is open,
// and one already showing goes away the moment a panel opens. In the dock that second
// half is free: its menu is a popover with its own grab, so the pointer LEAVES the
// icon and the tooltip closes on leave. A bar panel is drawn in the bar's own surface,
// so the pointer never leaves the capsule it just clicked and the bubble stayed over
// the panel. Here "a panel is open" is Status state, so that is what closes it.
// `bar-overflow-open` is here only so the `»` capsule repaints as OPEN; it does not
// suppress tooltips (barPanelOpen), since the unfolded widgets are ordinary pills.
const PANEL_PROPS = ["bar-expanded-id", "cc-open", "nc-open", "system-menu-open", "prism-open", "bar-overflow-open"]

// The widget that anchors the bar's shared "custom" expansion (a tray item's menu,
// the window menu). Bar.tsx sets it; it counts only while that expansion is up.
export const CUSTOM_EXPANSION_ID = "__custom"
let customAnchor: Gtk.Widget | null = null
const anchorListeners = new Set<() => void>()
export function setBarCustomAnchor(anchor: Gtk.Widget | null) {
    if (customAnchor === anchor) return
    customAnchor = anchor
    for (const cb of anchorListeners) cb()
}
export const isBarCustomAnchor = (w: Gtk.Widget) =>
    status.bar_expanded_id === CUSTOM_EXPANSION_ID && customAnchor === w

/** SquircleContainer props that paint a bar capsule OPEN while `isOpen()` holds —
 *  the capsule stays marked for as long as the panel it opened is down. */
export function barOpen(isOpen: () => boolean) {
    return {
        getOpen: isOpen,
        watchOpen: (cb: () => void) => {
            const ids = PANEL_PROPS.map(p => status.connect(`notify::${p}`, cb))
            anchorListeners.add(cb)
            return () => {
                for (const id of ids) safeDisconnect(status, id)
                anchorListeners.delete(cb)
            }
        },
    }
}

const openTips = new Set<NidaraTooltipHandle>()
const closeAll = () => { if (barPanelOpen()) for (const tip of openTips) tip.popover.popdown() }
for (const prop of ["bar-expanded-id", "cc-open", "nc-open", "system-menu-open"])
    status.connect(`notify::${prop}`, closeAll)

// The bar's dwell before a tooltip shows: twice the kit's 500, counted from when the
// pointer STOPS on the capsule (`restToShow`), not from when it arrives. Every capsule
// has one (owner, 2026-09-26), and the bar is a row you cross on the way to the capsule
// you want — at 500 from arrival the bubbles popped up over everything the pointer
// merely passed (owner, same day: "in the dock it is fine, in the bar it is too
// little"; then: "better if it only shows when the mouse stays still for a second").
// The dock keeps the kit's default.
export const BAR_TOOLTIP_DELAY = 1000

export function barTooltip(widget: Gtk.Widget, text: NidaraTooltipText, opts: NidaraTooltipOpts = {}) {
    const tip = attachTooltip(widget, text, { position: Gtk.PositionType.BOTTOM, delay: BAR_TOOLTIP_DELAY, restToShow: true, ...opts, suppress: barPanelOpen })
    openTips.add(tip)
    widget.connect("destroy", () => openTips.delete(tip))
    return tip
}
