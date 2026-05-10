import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import BaseIsland from "./BaseIsland"
import ccLayout, { UNIT, GAP, GRID_COLS, GRID_ROWS, GRID_WIDTH, GRID_HEIGHT, SIZE_MAP } from "./CCLayoutManager"
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
let dragSourceWidget: Gtk.Widget | null = null
const dragOrigSnapshot = new Map<string, { x: number; y: number }>()

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
    gy = Math.max(0, Math.min(GRID_ROWS - h, gy))
    return { gx, gy }
}

function makeIslandWidget(
    id: string,
    editMode: boolean,
    onRemove: () => void,
    onResize: () => void,
    fixed: Gtk.Fixed,
    onDragBegin: (dragged: Gtk.Widget) => void,
    onDragEnd: (dragged: Gtk.Widget, deleteData: boolean) => void,
    showDetail: ((id: string) => void) | null,
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

    // Tiles with CC detail: BUBBLE + released so child buttons claim the sequence
    // on press and deny this gesture — button taps work from the compact tile,
    // neutral-area taps open the squircle detail. GestureClick self-cancels on
    // motion > threshold, leaving slider drags unaffected.
    if (!editMode && def.buildCCDetail && showDetail) {
        const overlay = new Gtk.Overlay()
        overlay.set_child(island)
        overlay.set_size_request(width, height)
        const click = new Gtk.GestureClick()
        click.connect("released", () => showDetail(id))
        overlay.add_controller(click)
        return overlay
    }

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
        // Clean up any previous stuck drag source
        if (dragSourceWidget && dragSourceWidget !== overlay) {
            dragSourceWidget.remove_css_class("cc-drag-source")
            dragSourceWidget = null
        }
        dragOffsetX  = x
        dragOffsetY  = y
        dragWidgetId = id
        const val = new GObject.Value()
        val.init(GObject.TYPE_STRING)
        val.set_string(id)
        return Gdk.ContentProvider.new_for_value(val)
    })

    dragSrc.connect("drag-begin", (_: any, drag: any) => {
        try {
            const paintable = new Gtk.WidgetPaintable({ widget: island })
            Gtk.DragIcon.set_from_paintable(drag, paintable,
                Math.round(dragOffsetX), Math.round(dragOffsetY))
        } catch {}
        onDragBegin(overlay)
    })

    dragSrc.connect("drag-end", (_src: any, _drag: any, deleteData: boolean) => {
        onDragEnd(overlay, deleteData)
    })

    overlay.add_controller(dragSrc)
    return overlay
}

export default function IslandGrid() {
    let editMode = false
    let activeDetailId = ""

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

    // ── Detail page (full-panel, macOS Tahoe style) ───────────────────────────
    const mainStack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: 200,
        hexpand: false,
        halign: Gtk.Align.END,
    })

    // Overview page: grid + edit button live here
    const overviewPage = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.END })

    // Detail page — single squircle containing header + content (built fresh per widget)
    const detailPage = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.END,
        width_request: GRID_WIDTH,
    })
    // detailIsland is appended/removed dynamically

    mainStack.add_named(overviewPage, "overview")
    mainStack.add_named(detailPage, "detail")
    mainStack.set_visible_child_name("overview")

    let detailIsland: Gtk.Widget | null = null

    const hideDetail = () => {
        activeDetailId = ""
        mainStack.set_visible_child_name("overview")
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            if (detailIsland) { try { detailPage.remove(detailIsland) } catch {} ; detailIsland = null }
            return GLib.SOURCE_REMOVE
        })
    }

    const showDetail = (id: string) => {
        if (editMode) return
        const w = registry.get(id)
        if (!w?.buildCCDetail) return
        if (activeDetailId === id) { hideDetail(); return }

        if (detailIsland) { try { detailPage.remove(detailIsland) } catch {} ; detailIsland = null }

        activeDetailId = id

        const rows = w.ccDetailRows ?? 2
        const cellH = rows * (UNIT + GAP) - GAP

        // Header: back button + title — lives inside the squircle for glass contrast
        const backBtnChild = new Gtk.Box({ spacing: 6, margin_start: 8, margin_end: 8, margin_top: 12, margin_bottom: 12 })
        backBtnChild.append(new Gtk.Image({ gicon: Icons.chevronLeft, pixel_size: 14, css_classes: ["cs-icon"] }))
        backBtnChild.append(new Gtk.Label({ label: w.name, css_classes: ["cc-detail-title"], halign: Gtk.Align.START }))
        const backBtn = new Gtk.Button({ child: backBtnChild, css_classes: ["cc-detail-back-btn"], halign: Gtk.Align.START, margin_start: 4, margin_top: 4 })
        backBtn.connect("clicked", hideDetail)

        // Content
        const panel = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ["cc-detail-panel"],
            hexpand: true,
            margin_start: 8, margin_end: 8, margin_bottom: 10,
        })
        panel.append(w.buildCCDetail(hideDetail))

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            height_request: cellH,
        })
        scroll.set_child(panel)

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: GRID_WIDTH })
        inner.append(backBtn)
        inner.append(new Gtk.Separator({ css_classes: ["cc-detail-sep"], margin_bottom: 4 }))
        inner.append(scroll)

        detailIsland = SquircleContainer({
            child: inner,
            gloss: true,
            useShellOpacity: true,
            borderColor: { r: 1, g: 1, b: 1, a: 0.12 },
            radius: 24,
        })
        detailPage.append(detailIsland)
        mainStack.set_visible_child_name("detail")
    }

    // Per-instance reflow state
    const widgetRefs = new Map<string, Gtk.Widget>()

    const applySnapshotVisually = () => {
        for (const [id, pos] of dragOrigSnapshot) {
            const ref = widgetRefs.get(id)
            if (ref) fixed.move(ref, pixelX(pos.x), pixelY(pos.y))
        }
    }

    const handleDragBegin = (overlay: Gtk.Widget) => {
        dragOrigSnapshot.clear()
        for (const entry of ccLayout.layout)
            dragOrigSnapshot.set(entry.id, { x: entry.x, y: entry.y })
        dragSourceWidget = overlay
        overlay.add_css_class("cc-drag-source")
    }

    const handleDragEnd = (overlay: Gtk.Widget, deleteData: boolean) => {
        try { overlay.remove_css_class("cc-drag-source") } catch {}
        dragSourceWidget = null
        if (!deleteData) {
            applySnapshotVisually()
        }
        dragOrigSnapshot.clear()
        dragWidgetId = ""
    }

    // Drop target — always present, only activates when drag sources are added (edit mode)
    const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)

    dropTarget.connect("motion", (_: any, x: number, y: number) => {
        if (!dragWidgetId) return Gdk.DragAction.MOVE
        const snap = snapToGrid(dragWidgetId, x, y)
        if (!snap) return Gdk.DragAction.MOVE

        const preview = ccLayout.previewLayout(dragWidgetId, snap.gx, snap.gy)
        for (const [id, pos] of preview) {
            const ref = widgetRefs.get(id)
            if (ref) fixed.move(ref, pixelX(pos.x), pixelY(pos.y))
        }

        return Gdk.DragAction.MOVE
    })

    dropTarget.connect("drop", (_: any, _value: any, x: number, y: number) => {
        const id = dragWidgetId
        if (!id) return false
        const snap = snapToGrid(id, x, y)
        if (!snap) return false
        ccLayout.commitPreview(id, snap.gx, snap.gy)
        return true
    })

    dropTarget.connect("leave", () => {
        if (dragOrigSnapshot.size > 0) applySnapshotVisually()
    })

    fixed.add_controller(dropTarget)

    const editLabel = new Gtk.Label({ label: t("cc.grid.edit"), margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 })
    const editBtn = SquircleContainer({ child: editLabel, shape: Shape.CAPSULE, useShellOpacity: true, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, css_classes: ["cc-edit-pill"] })
    const editBtnWrapper = new Gtk.Box({ halign: Gtk.Align.CENTER, hexpand: true, margin_top: 24, margin_bottom: 12 })
    editBtnWrapper.append(editBtn)

    overviewPage.append(fixed)
    overviewPage.append(editBtnWrapper)
    outer.append(mainStack)

    const rebuild = () => {
        dragWidgetId = ""
        dragOrigSnapshot.clear()
        widgetRefs.clear()
        dragSourceWidget = null

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
                handleDragBegin,
                handleDragEnd,
                editMode ? null : showDetail,
            )
            if (widget) {
                fixed.put(widget, pixelX(entry.x), pixelY(entry.y))
                widgetRefs.set(entry.id, widget)
            }
        }

        editLabel.label = editMode ? t("cc.grid.done") : t("cc.grid.edit")
    }

    const gestureClick = new Gtk.GestureClick()
    gestureClick.connect("released", () => {
        editMode = !editMode
        status.cc_edit_mode = editMode
        if (editMode) hideDetail()
        rebuild()
    })
    editBtn.add_controller(gestureClick)
    ccLayout.connect("changed", () => rebuild())

    // Sync CC layout with widget placement config
    const syncCCLayout = () => {
        const activeInCC = new Set(ccLayout.activeIds())
        for (const w of registry.ccCapable()) {
            const inCC = widgetConfig.get(w.id).cc
            if (inCC && !activeInCC.has(w.id)) ccLayout.add(w.id)
            else if (!inCC && activeInCC.has(w.id)) ccLayout.remove(w.id)
        }
    }
    syncCCLayout()  // initial pass — catches widgets enabled before WIDGET_META had their entry
    widgetConfig.connect("changed", syncCCLayout)

    // Reset edit mode + detail strip when CC is closed
    status.connect("notify::cc-open", () => {
        if (!status.cc_open) {
            hideDetail()
            if (editMode) {
                editMode = false
                status.cc_edit_mode = false
                rebuild()
            }
        }
    })

    // Open a specific detail view when requested from outside (e.g. bar widget tap)
    status.connect("notify::cc-detail-id", () => {
        const id = status.cc_detail_id
        if (id) {
            status.cc_detail_id = ""
            showDetail(id)
        }
    })

    rebuild()
    return outer
}
