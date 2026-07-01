import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import BaseIsland, { islandPadding, resolveIslandShape } from "./BaseIsland"
import ccLayout, { UNIT, GAP, GRID_COLS, GRID_ROWS, GRID_WIDTH, GRID_HEIGHT, SIZE_MAP } from "./CCLayoutManager"
import { AtomicWidget, WidgetSize } from "./Types"
import status from "../../core/Status"
import widgetConfig from "../../core/WidgetConfig"
import registry, { widgetAvailable, watchWidgetAvailability } from "../../widgets/index"
import Icons from "../../core/Icons"
import { t } from "../../core/i18n"
import SquircleContainer, { Shape, resolveDrawParams } from "../../common/SquircleContainer"
import { drawSquircle } from "../../common/DrawingUtils"
import Theme from "../../core/ThemeManager"
import IconButton from "../../common/IconButton"
import { createCCContextMenu } from "./CCContextMenu"

const pixelX = (gx: number) => gx * (UNIT + GAP)
const pixelY = (gy: number) => gy * (UNIT + GAP)

// Drag-ghost: a Cairo-painted placeholder shaped like the dragged widget's
// actual BaseIsland silhouette (circle/capsule/squircle/dock-pill) instead of a
// generic rounded box, so the landing indicator previews the real tile. Returns
// a setter for the "can't drop here" tint since the colors are baked into the
// draw call, not CSS-driven like a normal tile.
const GHOST_DANGER = { r: 1, g: 59 / 255, b: 48 / 255 }

function makeDropGhost(size: WidgetSize, w: number, h: number): { widget: Gtk.DrawingArea; setInvalid: (v: boolean) => void } {
    const { shape, radius } = resolveIslandShape(size, w, h)
    let invalid = false
    const da = new Gtk.DrawingArea({ width_request: w, height_request: h })
    da.set_can_target(false)
    da.set_draw_func((_widget: Gtk.DrawingArea, cr: any, dw: number, dh: number) => {
        const { radius: r, n, perfect } = resolveDrawParams(shape, radius, 3.2, false, dw, dh)
        let accent: { r: number; g: number; b: number }
        if (invalid) {
            accent = GHOST_DANGER
        } else {
            const hex = Theme.accentPalette[Theme.accentColor].color
            accent = {
                r: parseInt(hex.slice(1, 3), 16) / 255,
                g: parseInt(hex.slice(3, 5), 16) / 255,
                b: parseInt(hex.slice(5, 7), 16) / 255,
            }
        }
        drawSquircle(cr, dw, dh, undefined, 0.12, false, accent, r, perfect, { ...accent, a: 0.6 }, n, 2, 2.0, [4, 3])
    })
    return {
        widget: da,
        setInvalid: (v: boolean) => { if (v !== invalid) { invalid = v; da.queue_draw() } },
    }
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

// Grid cell (top-left) the dragged tile snaps to, from the pointer position
// (relative to fixed). Accounts for where inside the tile it was grabbed
// (dragOffset) so the tile — not the cursor pixel — tracks the grid, then clamps
// the cell so the whole footprint stays on the board. Free 2D placement: the tile
// lands exactly here if it fits (CCLayoutManager.canPlace).
function dragCell(id: string, dropX: number, dropY: number): { x: number; y: number } {
    const { w, h } = SIZE_MAP[ccLayout.effectiveSize(id)]
    let x = Math.round((dropX - dragOffsetX) / (UNIT + GAP))
    let y = Math.round((dropY - dragOffsetY) / (UNIT + GAP))
    x = Math.max(0, Math.min(x, GRID_COLS - w))
    y = Math.max(0, Math.min(y, GRID_ROWS - h))
    return { x, y }
}

function makeIslandWidget(
    id: string,
    editMode: boolean,
    fixed: Gtk.Fixed,
    onDragBegin: (dragged: Gtk.Widget) => void,
    onDragEnd: (dragged: Gtk.Widget, deleteData: boolean) => void,
    showDetail: ((id: string) => void) | null,
    openMenu: (id: string, anchorX: number, anchorY: number) => void,
): Gtk.Widget | null {
    const entry = ccLayout.layout.find(e => e.id === id)
    if (!entry) return null

    const def = getWidgetById(id)
    if (!def) return null

    const effectiveSize = ccLayout.effectiveSize(id)
    const { w, h } = SIZE_MAP[effectiveSize]
    const width  = w * UNIT + (w - 1) * GAP
    const height = h * UNIT + (h - 1) * GAP

    // ContentBudget: the tile span minus the island's padding — what the
    // widget may size its content from (zero-layout contract).
    const pad = islandPadding(effectiveSize)
    const content = def.buildContent(effectiveSize, { width: width - 2 * pad, height: height - 2 * pad })
    const island  = BaseIsland({
        name: def.id, child: content, width, height, size: effectiveSize, centerContent: def.centerContent,
        getActive: def.getActive, watchActive: def.watchActive,
        getFill: def.getFill ? () => def.getFill!(effectiveSize) : undefined,
    })

    const overlay = new Gtk.Overlay()
    overlay.set_child(island)
    overlay.set_size_request(width, height)

    // Secondary-click → context menu (size picker + remove), available in every
    // mode. Anchor is the tile's grid origin + the local click point, expressed
    // in the grid Fixed's coordinate space (where the menu overlay lives).
    const secondary = new Gtk.GestureClick()
    secondary.set_button(Gdk.BUTTON_SECONDARY)
    secondary.connect("pressed", (_g: any, _n: number, x: number, y: number) => {
        openMenu(id, pixelX(entry.x) + x, pixelY(entry.y) + y)
    })
    overlay.add_controller(secondary)

    if (!editMode) {
        // Primary tap opens the squircle detail (only for tiles that have one).
        // Bound to PRIMARY so right-click is left to the context menu. GestureClick
        // self-cancels on motion > threshold, leaving slider drags unaffected.
        if (def.buildCCDetail && showDetail) {
            const click = new Gtk.GestureClick()
            click.set_button(Gdk.BUTTON_PRIMARY)
            click.connect("released", () => showDetail(id))
            overlay.add_controller(click)
        }
        return overlay
    }

    // ── edit mode: × remove (kept alongside the context menu's Remove) + drag ──
    // Tile content must not be a pointer target while editing: a slider's own
    // GestureDrag claims the sequence ON PRESS (see Slider.ts — deliberate, so a
    // normal-mode slider drag doesn't also open the tile's detail), which beats
    // `dragSrc` below to every press since GTK delivers bubble-phase events
    // target-first. With content untargetable, `pick()` resolves the press
    // straight to `overlay`, so the tile-move drag always wins — and nothing
    // inside a tile should be independently actionable while rearranging anyway
    // (only the × badge below and the drag itself are live, matching jiggle-mode
    // elsewhere).
    content.set_can_target(false)

    // Clear the placement flag too (not just the layout), or syncCCLayout re-adds
    // the widget on next load — cc_layout.json and widgetConfig must agree.
    const removeBtn = IconButton({
        icon: Icons.close, iconSize: 13, variant: "danger",
        halign: Gtk.Align.END, valign: Gtk.Align.START,
        onClick: () => { widgetConfig.setCC(id, false); ccLayout.remove(id) },
    })
    removeBtn.set_margin_top(4); removeBtn.set_margin_end(4)
    overlay.add_overlay(removeBtn)

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
    })

    // Empty-slot placeholders live on their OWN layer *below* the tiles. Tiles are
    // translucent glass, so a placeholder behind an occupied cell would bleed
    // through; keeping slots on a separate base layer (z-order guaranteed, no
    // Gtk.Fixed reorder API) and driving them from the live layout means an occupied
    // cell never shows the free-slot background, and the cell a dragged tile vacates
    // correctly reveals one.
    const slotLayer = new Gtk.Fixed({
        width_request: GRID_WIDTH,
        height_request: GRID_HEIGHT,
    })
    const gridLayers = new Gtk.Overlay()
    gridLayers.set_child(slotLayer)
    gridLayers.add_overlay(fixed)

    // Hard width clamp. The CC is a right-anchored, content-sized overlay child, so
    // anything that makes its content wider than GRID_WIDTH shifts the whole panel
    // left. Gtk.Fixed reports its children's *natural* width, and a tile whose
    // content (e.g. a labelled capsule) overruns its cell pushes that natural past
    // GRID_WIDTH — and which tile sits at the edge changes on reorder/resize, so the
    // shift moves around. A ScrolledWindow with propagate_natural_width=false reports
    // a width independent of its child; width_request then pins it to GRID_WIDTH and
    // any per-tile overrun is clipped instead of widening the panel.
    const gridClamp = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: false,
        propagate_natural_height: true,
        width_request: GRID_WIDTH,
        halign: Gtk.Align.END,
        css_classes: ["cc-grid-clamp"],
    })
    gridClamp.set_child(gridLayers)

    // Context menu (size picker + remove) floats in an overlay over the grid so
    // it isn't clipped by tiles; its coordinates match the Fixed's space — see
    // the anchor math in makeIslandWidget.
    const ctxMenu = createCCContextMenu()
    const openMenu = (id: string, anchorX: number, anchorY: number) =>
        ctxMenu.open(id, anchorX, anchorY, fixed.height_request)

    const gridOverlay = new Gtk.Overlay({ halign: Gtk.Align.END, width_request: GRID_WIDTH })
    gridOverlay.set_child(gridClamp)
    gridOverlay.add_overlay(ctxMenu.scrim)
    gridOverlay.add_overlay(ctxMenu.menu)

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
        backBtnChild.append(new Gtk.Image({ gicon: Icons.chevronLeft, pixel_size: 14, css_classes: ["nd-icon"] }))
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

    // ── Animated reflow ───────────────────────────────────────────────────────
    // During a drag the non-dragged tiles glide to their new positions instead of
    // snapping. A tick callback lerps each tile's current pixel position toward its
    // target; when all have arrived it removes itself. animPos holds the live
    // (possibly mid-flight) position so re-targeting mid-animation is seamless.
    const animPos = new Map<string, { x: number; y: number }>()
    const animTarget = new Map<string, { x: number; y: number }>()
    let animId = 0

    const animStep = (): boolean => {
        const k = 0.32 // per-frame approach factor (~snappy but smooth)
        let moving = false
        for (const [id, target] of animTarget) {
            const ref = widgetRefs.get(id)
            if (!ref) continue
            let cur = animPos.get(id)
            if (!cur) { cur = { x: target.x, y: target.y }; animPos.set(id, cur) }
            const dx = target.x - cur.x, dy = target.y - cur.y
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                if (cur.x !== target.x || cur.y !== target.y) {
                    cur.x = target.x; cur.y = target.y
                    fixed.move(ref, cur.x, cur.y)
                }
            } else {
                cur.x += dx * k; cur.y += dy * k
                fixed.move(ref, Math.round(cur.x), Math.round(cur.y))
                moving = true
            }
        }
        if (!moving) { animId = 0; return false }
        return true
    }

    const animateTo = (targets: Map<string, { x: number; y: number }>) => {
        animTarget.clear()
        for (const [id, p] of targets) animTarget.set(id, p)
        if (!animId) animId = fixed.add_tick_callback(animStep)
    }

    const stopAnim = () => {
        if (animId) { try { fixed.remove_tick_callback(animId) } catch {} ; animId = 0 }
        animTarget.clear()
        animPos.clear()
    }

    // ── Empty-slot placeholders (on slotLayer, below the tiles) ────────────────
    // Reconciled to a target set of cells: kept across motions to avoid flicker,
    // added/removed only where the empty set changes.
    const slotRefs = new Map<string, Gtk.Widget>()
    const makeSlot = () => {
        const s = new Gtk.Box({ css_classes: ["cc-slot-placeholder"], width_request: UNIT, height_request: UNIT })
        s.set_can_target(false)
        return s
    }
    const syncSlots = (cells: Array<{ x: number; y: number }>) => {
        const want = new Set(cells.map(c => `${c.x},${c.y}`))
        for (const [k, w] of [...slotRefs])
            if (!want.has(k)) { try { slotLayer.remove(w) } catch {} ; slotRefs.delete(k) }
        for (const c of cells) {
            const k = `${c.x},${c.y}`
            if (!slotRefs.has(k)) {
                const s = makeSlot()
                slotLayer.put(s, pixelX(c.x), pixelY(c.y))
                slotRefs.set(k, s)
            }
        }
    }
    const clearSlots = () => {
        for (const [, w] of slotRefs) { try { slotLayer.remove(w) } catch {} }
        slotRefs.clear()
    }

    // Empty cells implied by a previewed reflow (Map id→cell), so a drag updates
    // the slot backdrop live: the dragged tile's landing cell is occupied (the ghost
    // sits there, no slot), and the cell it left turns into a slot.
    const emptyCellsOf = (preview: Map<string, { x: number; y: number }>): Array<{ x: number; y: number }> => {
        const occ = new Set<string>()
        for (const [id, pos] of preview) {
            const { w, h } = SIZE_MAP[ccLayout.effectiveSize(id)]
            for (let dy = 0; dy < h; dy++)
                for (let dx = 0; dx < w; dx++)
                    occ.add(`${pos.x + dx},${pos.y + dy}`)
        }
        const empty: Array<{ x: number; y: number }> = []
        for (let row = 0; row < GRID_ROWS; row++)
            for (let col = 0; col < GRID_COLS; col++)
                if (!occ.has(`${col},${row}`)) empty.push({ x: col, y: row })
        return empty
    }

    // Accent dashed slot showing exactly where the dragged tile will land. It rides
    // the same tween as the tiles (registered under a sentinel key) so it glides into
    // the opening gap instead of snapping ahead of the parting tiles.
    const GHOST_KEY = "\u0000drop-ghost"
    let dropGhost: Gtk.Widget | null = null
    let dropGhostSetInvalid: ((v: boolean) => void) | null = null
    const removeGhost = () => {
        if (dropGhost) { try { fixed.remove(dropGhost) } catch {} ; dropGhost = null }
        dropGhostSetInvalid = null
        widgetRefs.delete(GHOST_KEY)
    }

    // Animate every tile (and the ghost, under GHOST_KEY) back to the pre-drag
    // snapshot — used on drag-leave (re-enterable) and on a cancelled drop.
    const applySnapshotVisually = () => {
        const targets = new Map<string, { x: number; y: number }>()
        for (const [id, pos] of dragOrigSnapshot) {
            const key = id === dragWidgetId ? GHOST_KEY : id
            targets.set(key, { x: pixelX(pos.x), y: pixelY(pos.y) })
        }
        animateTo(targets)
        syncSlots(ccLayout.getEmptyCells())  // back to the resting empty-slot set
    }

    const handleDragBegin = (overlay: Gtk.Widget) => {
        dragOrigSnapshot.clear()
        animPos.clear()
        for (const entry of ccLayout.layout) {
            dragOrigSnapshot.set(entry.id, { x: entry.x, y: entry.y })
            // Seed live positions so the first reflow lerps from the real spot.
            animPos.set(entry.id, { x: pixelX(entry.x), y: pixelY(entry.y) })
        }
        dragSourceWidget = overlay
        overlay.add_css_class("cc-drag-source")

        // Spawn the landing-slot ghost at the dragged tile's footprint; it rides the
        // tween into the opening gap so the displacement reads clearly.
        const dragSize = ccLayout.effectiveSize(dragWidgetId)
        const { w, h } = SIZE_MAP[dragSize]
        const gw = w * UNIT + (w - 1) * GAP
        const gh = h * UNIT + (h - 1) * GAP
        removeGhost()
        const ghost = makeDropGhost(dragSize, gw, gh)
        dropGhost = ghost.widget
        dropGhostSetInvalid = ghost.setInvalid
        const src = dragOrigSnapshot.get(dragWidgetId)
        const sx = src ? pixelX(src.x) : 0, sy = src ? pixelY(src.y) : 0
        fixed.put(dropGhost, sx, sy)
        widgetRefs.set(GHOST_KEY, dropGhost)
        animPos.set(GHOST_KEY, { x: sx, y: sy })
    }

    const handleDragEnd = (overlay: Gtk.Widget, deleteData: boolean) => {
        try { overlay.remove_css_class("cc-drag-source") } catch {}
        dragSourceWidget = null
        removeGhost()
        if (!deleteData) applySnapshotVisually()  // cancelled drop → reflow back
        dragOrigSnapshot.clear()
        dragWidgetId = ""
    }

    // Drop target — always present, only activates when drag sources are added (edit mode)
    const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)

    dropTarget.connect("motion", (_: any, x: number, y: number) => {
        if (!dragWidgetId) return Gdk.DragAction.MOVE
        const cell = dragCell(dragWidgetId, x, y)

        // Insert the dragged tile at the pointed cell and reflow everything else to
        // make room; tiles (and the ghost, for the dragged tile) glide to the result.
        const preview = ccLayout.previewLayout(dragWidgetId, cell.x, cell.y)
        if (!preview) {
            // Can't drop here (off-grid or a displaced tile wouldn't fit anywhere):
            // mark the ghost invalid and hold the other tiles where they are.
            dropGhostSetInvalid?.(true)
            animateTo(new Map([[GHOST_KEY, { x: pixelX(cell.x), y: pixelY(cell.y) }]]))
            return 0 as any
        }
        dropGhostSetInvalid?.(false)

        // Drop where pointed; only overlapped tiles slide aside (downward-biased).
        const targets = new Map<string, { x: number; y: number }>()
        for (const [id, pos] of preview) {
            const key = id === dragWidgetId ? GHOST_KEY : id
            targets.set(key, { x: pixelX(pos.x), y: pixelY(pos.y) })
        }
        animateTo(targets)
        syncSlots(emptyCellsOf(preview))  // vacated cell shows a slot; occupied cells don't

        return Gdk.DragAction.MOVE
    })

    dropTarget.connect("drop", (_: any, _value: any, x: number, y: number) => {
        const id = dragWidgetId
        if (!id) return false
        const cell = dragCell(id, x, y)
        return ccLayout.commitPreview(id, cell.x, cell.y)  // false → invalid, source reverts
    })

    dropTarget.connect("leave", () => {
        if (dragOrigSnapshot.size > 0) applySnapshotVisually()
    })

    fixed.add_controller(dropTarget)

    const editLabel = new Gtk.Label({ label: t("cc.grid.edit"), margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 })
    const editBtn = SquircleContainer({ child: editLabel, shape: Shape.CAPSULE, useShellOpacity: true, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, css_classes: ["cc-edit-pill"] })
    const editBtnWrapper = new Gtk.Box({ halign: Gtk.Align.CENTER, hexpand: true, margin_top: 24, margin_bottom: 12 })
    editBtnWrapper.append(editBtn)

    overviewPage.append(gridOverlay)
    overviewPage.append(editBtnWrapper)
    outer.append(mainStack)

    const rebuild = () => {
        dragWidgetId = ""
        dragOrigSnapshot.clear()
        widgetRefs.clear()
        dragSourceWidget = null
        stopAnim()
        dropGhost = null   // cleared by the child-removal loop below
        dropGhostSetInvalid = null
        ctxMenu.close()

        let child = fixed.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            fixed.remove(child)
            child = next
        }

        // Resize both layers to match actual content in normal mode; full grid in edit mode
        fixed.height_request = slotLayer.height_request = editMode ? GRID_HEIGHT : computeContentHeight()

        // Empty-slot placeholders live on slotLayer (below tiles); only in edit mode.
        clearSlots()
        if (editMode) syncSlots(ccLayout.getEmptyCells())

        for (const entry of ccLayout.layout) {
            const widget = makeIslandWidget(
                entry.id, editMode,
                fixed,
                handleDragBegin,
                handleDragEnd,
                editMode ? null : showDetail,
                openMenu,
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

    // Sync CC layout with widget placement config. Hardware gate at the layout
    // level (not render) so the grid stays coherent: no invisible tiles blocking
    // cells in edit mode. widgetConfig (the user's intent) is never mutated —
    // when the hardware returns, the widget is re-added on the next sync.
    const syncCCLayout = () => {
        const activeInCC = new Set(ccLayout.activeIds())
        for (const w of registry.ccCapable()) {
            const inCC = widgetConfig.get(w.id).cc && widgetAvailable(w)
            if (inCC && !activeInCC.has(w.id)) ccLayout.add(w.id)
            else if (!inCC && activeInCC.has(w.id)) ccLayout.remove(w.id)
        }
    }
    syncCCLayout()  // initial pass — catches widgets enabled before WIDGET_META had their entry
    widgetConfig.connect("changed", syncCCLayout)
    watchWidgetAvailability(syncCCLayout)

    // Reset edit mode + detail strip when CC is closed
    status.connect("notify::cc-open", () => {
        if (!status.cc_open) {
            ctxMenu.close()
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
