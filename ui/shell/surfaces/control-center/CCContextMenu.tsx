import { Gtk } from "ags/gtk4"
import ccLayout, { GRID_WIDTH, SIZE_TIER, SizeTier } from "./CCLayoutManager"
import { WidgetSize } from "./Types"
import widgetConfig from "../../core/WidgetConfig"
import registry from "../../widgets/index"
import Icons from "../../core/Icons"
import { t } from "../../core/i18n"
import SquircleContainer from "../../common/SquircleContainer"
import { menuRow, menuSeparator } from "../../common/MenuRow"

// Right-click context menu for CC tiles — macOS-style.
// Replaces the old cycling "1×1 → 2×1" pill with a standardized size picker
// (Small / Medium / Large) plus Remove. Built as a floating Gtk.Box hosted in
// the grid overlay (NOT a Gtk.Popover — see project_nidara_ui: the GTK binary's
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

export interface CCContextMenuOpts {
    // "Show details" row action — opens the tile's detail panel. The row only
    // renders for widgets that declare buildCCDetail AND while detailEnabled()
    // holds (the grid passes `() => !editMode`; a detail opened mid-rearrange
    // would fight the edit overlay).
    onShowDetail?: (id: string) => void
    detailEnabled?: () => boolean
}

export function createCCContextMenu(opts: CCContextMenuOpts = {}): CCContextMenu {
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

    // Whether this open would include the "Show details" row (also feeds doOpen's
    // height estimate so the menu doesn't get clamped short of its last row).
    const hasDetailRow = (id: string): boolean =>
        !!(registry.get(id)?.buildCCDetail && opts.onShowDetail && (opts.detailEnabled?.() ?? true))

    const populate = (id: string) => {
        clearRows()
        const cur = ccLayout.effectiveSize(id)
        const tiers = tierSizes(id)

        // "Show details" first — the primary action; sizing/removal are management.
        if (hasDetailRow(id)) {
            rows.append(menuRow({
                label: t("cc.menu.details"),
                onClick: () => { close(); opts.onShowDetail!(id) },
            }))
            rows.append(menuSeparator())
        }

        // Only offer sizes when there's an actual choice (>1 tier). A single-size
        // widget shows just Remove — no lone disabled row.
        if (tiers.length > 1) {
            for (const { tier, size } of tiers) {
                const isCurrent = size === cur
                const fits = isCurrent || ccLayout.canResize(id, size)
                rows.append(menuRow({
                    label: t(TIER_LABEL[tier]),
                    checked: isCurrent,
                    sensitive: !isCurrent && fits,
                    trailing: !isCurrent && !fits
                        ? new Gtk.Label({ label: t("cc.menu.size-full"), css_classes: ["cc-atomic-label-dim"], valign: Gtk.Align.CENTER })
                        : undefined,
                    onClick: () => { ccLayout.resize(id, size); close() },
                }))
            }
            rows.append(menuSeparator())
        }

        // Clear the authoritative placement flag too, else syncCCLayout re-adds the
        // widget on next load (cc_layout.json and widgetConfig must agree).
        rows.append(menuRow({
            label: t("cc.menu.remove"),
            icon: Icons.trash,
            danger: true,
            onClick: () => { widgetConfig.setCC(id, false); ccLayout.remove(id); close() },
        }))
    }

    const doOpen = (id: string, anchorX: number, anchorY: number, gridHeight: number) => {
        populate(id)
        // Estimate height to clamp inside the grid (details + size rows when >1 + remove + padding).
        const nTiers = tierSizes(id).length
        const nRows = (hasDetailRow(id) ? 1 : 0) + (nTiers > 1 ? nTiers : 0) + 1
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
