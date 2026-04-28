import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import BaseIsland from "./BaseIsland"
import ccLayout, { UNIT, GAP, GRID_COLS, GRID_WIDTH, GRID_HEIGHT, SIZE_MAP } from "./CCLayoutManager"
import { AtomicWidget, WidgetSize } from "./Types"
import status from "../../core/Status"
import widgetConfig from "../../core/WidgetConfig"
import registry from "../widgets/index"
import Icons from "../../core/Icons"
import { t } from "../../core/i18n"
import SquircleContainer, { Shape } from "../common/SquircleContainer"

const pixelX = (gx: number) => gx * (UNIT + GAP)
const pixelY = (gy: number) => gy * (UNIT + GAP)

const sizeLabel = (size: WidgetSize) => {
    const { w, h } = SIZE_MAP[size]
    return `${w}×${h}`
}

// Compute the pixel height needed to show all placed widgets (no extra padding)
function computeContentHeight(): number {
    if (ccLayout.layout.length === 0) return UNIT
    let maxRow = 0
    for (const entry of ccLayout.layout) {
        const { h } = SIZE_MAP[ccLayout.effectiveSize(entry.id)]
        maxRow = Math.max(maxRow, entry.y + h)
    }
    return maxRow * (UNIT + GAP) - GAP
}

// Per-drag state (only one drag at a time)
let dragOffsetX = 0
let dragOffsetY = 0
let dragWidgetId = ""

export function getWidgetById(id: string): AtomicWidget | null {
    try {
        return registry.get(id)
    } catch (e) {
        console.error(`[IslandGrid] Failed to resolve widget ${id}:`, e)
        return null
    }
}

// Snap pixel coords (relative to fixed) to nearest valid grid cell
function snapToGrid(id: string, dropX: number, dropY: number): { gx: number; gy: number } | null {
    const size  = ccLayout.effectiveSize(id)
    const { w, h } = SIZE_MAP[size]
    let gx = Math.round((dropX - dragOffsetX) / (UNIT + GAP))
    let gy = Math.round((dropY - dragOffsetY) / (UNIT + GAP))
    gx = Math.max(0, Math.min(GRID_COLS - w, gx))
    gy = Math.max(0, gy)
    return { gx, gy }
}

function makeIslandWidget(
    id: string,
    editMode: boolean,
    onRemove: () => void,
    onResize: () => void,
    fixed: Gtk.Fixed,
    removeGhost: () => void,
): Gtk.Widget | null {
    const entry = ccLayout.layout.find(e => e.id === id)
    if (!entry) return null

    const def = getWidgetById(id)
    if (!def) return null

    const effectiveSize = ccLayout.effectiveSize(id)
    const { w, h } = SIZE_MAP[effectiveSize]
    const width  = w * UNIT + (w - 1) * GAP
    const height = h * UNIT + (h - 1) * GAP

    const content = def.buildContent(effectiveSize)
    const island  = BaseIsland({ name: def.id, child: content, width, height, size: effectiveSize })

    if (!editMode) return island

    const overlay = new Gtk.Overlay()
    overlay.set_child(island)
    overlay.set_size_request(width, height)

    // × remove
    const removeBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.close, pixel_size: 14 , css_classes: ["cs-icon"] }),
        css_classes: ["cc-remove-btn"],
        halign: Gtk.Align.END, valign: Gtk.Align.START,
        margin_top: 4, margin_end: 4,
    })
    removeBtn.connect("clicked", onRemove)
    overlay.add_overlay(removeBtn)

    // Resize pill
    const nextSize = ccLayout.nextResizeSize(id)
    if (nextSize !== null) {
        const resizeBtn = new Gtk.Button({
            label: `${sizeLabel(effectiveSize)} → ${sizeLabel(nextSize)}`,
            css_classes: ["cc-resize-btn"],
            halign: Gtk.Align.END, valign: Gtk.Align.END,
            margin_bottom: 6, margin_end: 6,
        })
        resizeBtn.connect("clicked", onResize)
        overlay.add_overlay(resizeBtn)
    }

    // Drag source
    const dragSrc = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })

    dragSrc.connect("prepare", (_: any, x: number, y: number) => {
        dragOffsetX  = x
        dragOffsetY  = y
        dragWidgetId = id
        const val = new GObject.Value()
        val.init(GObject.TYPE_STRING)
        val.set_string(id)
        return Gdk.ContentProvider.new_for_value(val)
    })

    dragSrc.connect("drag-begin", (_: any, drag: any) => {
        // Snapshot the island (without edit-mode decorations) as drag icon
        try {
            const paintable = new Gtk.WidgetPaintable({ widget: island })
            Gtk.DragIcon.set_from_paintable(drag, paintable,
                Math.round(dragOffsetX), Math.round(dragOffsetY))
        } catch {}
        removeGhost()
    })

    dragSrc.connect("drag-end", () => {
        removeGhost()
    })

    overlay.add_controller(dragSrc)
    return overlay
}

export default function IslandGrid() {
    let editMode = false

    const outer = new Gtk.Box({
        name: "island-grid-root",
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.END,
    })

    const fixed = new Gtk.Fixed({
        css_classes: ["island-grid-container"],
        width_request: GRID_WIDTH,
        height_request: GRID_HEIGHT,
        halign: Gtk.Align.END,
    })

    // Active ghost widget — recreated on every motion event to guarantee correct size
    let ghost: Gtk.Box | null = null
    const removeGhost = () => {
        if (ghost && ghost.get_parent() === fixed) fixed.remove(ghost)
        ghost = null
    }

    // Drop target — always present, only activates when drag sources are added (edit mode)
    const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)

    dropTarget.connect("motion", (_: any, x: number, y: number) => {
        if (!dragWidgetId) return Gdk.DragAction.MOVE
        const snap = snapToGrid(dragWidgetId, x, y)
        if (!snap) return Gdk.DragAction.MOVE

        const size = ccLayout.effectiveSize(dragWidgetId)
        const { w, h } = SIZE_MAP[size]
        const gw = w * UNIT + (w - 1) * GAP
        const gh = h * UNIT + (h - 1) * GAP

        // Recreate ghost each motion event — guarantees Gtk.Fixed measures it fresh
        removeGhost()
        ghost = new Gtk.Box({
            css_classes: ["cc-drop-ghost"],
            width_request: gw,
            height_request: gh,
        })
        fixed.put(ghost, pixelX(snap.gx), pixelY(snap.gy))

        return Gdk.DragAction.MOVE
    })

    dropTarget.connect("drop", (_: any, value: any, x: number, y: number) => {
        removeGhost()
        const id = typeof value === "string" ? value : (value as any).get_string?.() ?? ""
        if (!id) return false
        const snap = snapToGrid(id, x, y)
        if (!snap) return false
        ccLayout.move(id, snap.gx, snap.gy)
        dragWidgetId = ""
        return true
    })

    dropTarget.connect("leave", () => {
        removeGhost()
    })

    fixed.add_controller(dropTarget)

    const editLabel = new Gtk.Label({ label: t("cc.grid.edit"), margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 })
    const editBtn = SquircleContainer({ child: editLabel, shape: Shape.CAPSULE, alpha: 0.2, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, css_classes: ["cc-edit-pill"] })
    const editBtnWrapper = new Gtk.Box({ halign: Gtk.Align.CENTER, hexpand: true, margin_top: 20, margin_bottom: 8 })
    editBtnWrapper.append(editBtn)

    outer.append(fixed)
    outer.append(editBtnWrapper)

    const rebuild = () => {
        removeGhost()

        let child = fixed.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            fixed.remove(child)
            child = next
        }

        // Resize fixed to match actual content in normal mode; full grid in edit mode
        fixed.height_request = editMode ? GRID_HEIGHT : computeContentHeight()

        // Empty slot placeholders — only in edit mode, plain boxes (no cairo drawing)
        if (editMode) {
            for (const cell of ccLayout.getEmptyCells()) {
                const slot = new Gtk.Box({
                    css_classes: ["cc-slot-placeholder"],
                    width_request: UNIT,
                    height_request: UNIT,
                })
                slot.set_can_target(false)
                fixed.put(slot, pixelX(cell.x), pixelY(cell.y))
            }
        }

        for (const entry of ccLayout.layout) {
            const widget = makeIslandWidget(
                entry.id, editMode,
                () => ccLayout.remove(entry.id),
                () => {
                    const next = ccLayout.nextResizeSize(entry.id)
                    if (next !== null) ccLayout.resize(entry.id, next)
                },
                fixed,
                removeGhost,
            )
            if (widget) fixed.put(widget, pixelX(entry.x), pixelY(entry.y))
        }

        editLabel.label = editMode ? t("cc.grid.done") : t("cc.grid.edit")
    }

    const gestureClick = new Gtk.GestureClick()
    gestureClick.connect("released", () => {
        editMode = !editMode
        status.cc_edit_mode = editMode
        rebuild()
    })
    editBtn.add_controller(gestureClick)
    ccLayout.connect("changed", () => rebuild())

    // Sync CC layout when widget placement config changes
    widgetConfig.connect("changed", () => {
        const activeInCC = new Set(ccLayout.activeIds())
        for (const w of registry.ccCapable()) {
            const inCC = widgetConfig.get(w.id).cc
            if (inCC && !activeInCC.has(w.id)) ccLayout.add(w.id)
            else if (!inCC && activeInCC.has(w.id)) ccLayout.remove(w.id)
        }
    })

    // Reset edit mode when CC is closed
    status.connect("notify::cc-open", () => {
        if (!status.cc_open && editMode) {
            editMode = false
            status.cc_edit_mode = false
            rebuild()
        }
    })

    rebuild()
    return outer
}
