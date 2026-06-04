import { Gtk } from "ags/gtk4"
import ccLayout, { GRID_WIDTH, SIZE_TIER, SizeTier } from "./CCLayoutManager"
import { WidgetSize } from "./Types"
import widgetConfig from "../../core/WidgetConfig"
import registry from "../widgets/index"
import Icons from "../../core/Icons"
import { t } from "../../core/i18n"
import SquircleContainer from "../common/SquircleContainer"

// Right-click context menu for CC tiles — macOS-style.
// Replaces the old cycling "1×1 → 2×1" pill with a standardized size picker
// (Small / Medium / Large) plus Remove. Built as a floating Gtk.Box hosted in
// the grid overlay (NOT a Gtk.Popover — see project_crystal_ui: the GTK binary's
// popover CSS fallback can't be reset cleanly).

const MENU_W = 188
const ROW_H = 40
const TIER_LABEL = {
    [SizeTier.SMALL]:  "cc.menu.size.small",
    [SizeTier.MEDIUM]: "cc.menu.size.medium",
    [SizeTier.LARGE]:  "cc.menu.size.large",
} as const

// Distinct tiers a widget offers, in ascending order, each tied to its concrete
// footprint. Dedupes by tier (a widget never declares two sizes of one tier).
function tierSizes(id: string): Array<{ tier: SizeTier; size: WidgetSize }> {
    const def = registry.get(id)
    if (!def) return []
    const seen = new Set<SizeTier>()
    const out: Array<{ tier: SizeTier; size: WidgetSize }> = []
    for (const size of def.supportedSizes) {
        const tier = SIZE_TIER[size]
        if (seen.has(tier)) continue
        seen.add(tier)
        out.push({ tier, size })
    }
    return out.sort((a, b) => a.tier - b.tier)
}

export interface CCContextMenu {
    scrim: Gtk.Widget
    menu: Gtk.Widget
    open: (id: string, anchorX: number, anchorY: number, gridHeight: number) => void
    close: () => void
    isOpen: () => boolean
}

export function createCCContextMenu(): CCContextMenu {
    let open = false

    const rows = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        margin_top: 9, margin_bottom: 9, margin_start: 9, margin_end: 9,
    })

    const card = SquircleContainer({
        child: rows,
        radius: 20,
        gloss: true,
        // Near-opaque: GTK can't blur a widget against sibling content on the same
        // surface, so the menu must occlude the tiles beneath it. useShellOpacity
        // keeps it theme-coloured (dark/light) + redrawing on theme toggle.
        useShellOpacity: true,
        alpha: 0.97,
        borderColor: { r: 1, g: 1, b: 1, a: 0.1 },
        css_classes: ["cc-context-menu"],
    })

    const menu = new Gtk.Box({
        halign: Gtk.Align.START, valign: Gtk.Align.START,
        visible: false,
        width_request: MENU_W,
    })
    menu.append(card)

    // Full-area transparent scrim — click outside dismisses the menu. halign/valign
    // FILL makes it cover the overlay without hexpand/vexpand (which would propagate
    // up and let the menu's margin widen the right-anchored grid column → left shift).
    const scrim = new Gtk.Box({
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: false, vexpand: false, visible: false,
    })
    const scrimClick = new Gtk.GestureClick()
    scrimClick.connect("released", () => close())
    scrim.add_controller(scrimClick)

    const clearRows = () => {
        let c = rows.get_first_child()
        while (c) { rows.remove(c); c = rows.get_first_child() }
    }

    const close = () => {
        if (!open) return
        open = false
        menu.visible = false
        scrim.visible = false
        clearRows()
    }

    const makeSizeRow = (label: string, current: boolean, fits: boolean, onClick: () => void) => {
        const lbl = new Gtk.Label({ label, halign: Gtk.Align.START, hexpand: true, css_classes: ["crystal-menu-label"] })
        const inner = new Gtk.Box({ spacing: 10 })
        inner.append(lbl)
        if (current) {
            inner.append(new Gtk.Image({ gicon: Icons.check, pixel_size: 15, css_classes: ["cs-icon", "accent-label"], valign: Gtk.Align.CENTER }))
        } else if (!fits) {
            inner.append(new Gtk.Label({ label: t("cc.menu.size-full"), css_classes: ["cc-atomic-label-dim"], valign: Gtk.Align.CENTER }))
        }
        const btn = new Gtk.Button({ child: inner, css_classes: ["crystal-menu-row"], hexpand: true, sensitive: !current && fits })
        btn.connect("clicked", onClick)
        return btn
    }

    const populate = (id: string) => {
        clearRows()
        const cur = ccLayout.effectiveSize(id)
        const tiers = tierSizes(id)

        // Only offer sizes when there's an actual choice (>1 tier). A single-size
        // widget shows just Remove — no lone disabled row.
        if (tiers.length > 1) {
            for (const { tier, size } of tiers) {
                const isCurrent = size === cur
                const fits = isCurrent || ccLayout.canResize(id, size)
                rows.append(makeSizeRow(t(TIER_LABEL[tier]), isCurrent, fits, () => {
                    ccLayout.resize(id, size)
                    close()
                }))
            }
            rows.append(new Gtk.Separator({ css_classes: ["crystal-menu-sep"], margin_top: 4, margin_bottom: 4 }))
        }

        const removeLbl = new Gtk.Label({ label: t("cc.menu.remove"), halign: Gtk.Align.START, hexpand: true, css_classes: ["crystal-menu-label"] })
        const removeInner = new Gtk.Box({ spacing: 10 })
        removeInner.append(new Gtk.Image({ gicon: Icons.trash, pixel_size: 15, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
        removeInner.append(removeLbl)
        const removeBtn = new Gtk.Button({ child: removeInner, css_classes: ["crystal-menu-row", "danger-action"], hexpand: true })
        // Clear the authoritative placement flag too, else syncCCLayout re-adds the
        // widget on next load (cc_layout.json and widgetConfig must agree).
        removeBtn.connect("clicked", () => { widgetConfig.setCC(id, false); ccLayout.remove(id); close() })
        rows.append(removeBtn)
    }

    const doOpen = (id: string, anchorX: number, anchorY: number, gridHeight: number) => {
        populate(id)
        // Estimate height to clamp inside the grid (size rows when >1 + remove + padding).
        const nTiers = tierSizes(id).length
        const nRows = (nTiers > 1 ? nTiers : 0) + 1
        const estH = nRows * ROW_H + 28
        const x = Math.max(0, Math.min(anchorX, GRID_WIDTH - MENU_W))
        const y = Math.max(0, Math.min(anchorY, Math.max(0, gridHeight - estH)))
        menu.margin_start = x
        menu.margin_top = y
        open = true
        scrim.visible = true
        menu.visible = true
    }

    return { scrim, menu, open: doOpen, close, isOpen: () => open }
}

export default createCCContextMenu
