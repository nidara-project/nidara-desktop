import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"
import { WidgetSize } from "./Types"
import { WIDGET_META, CC_DEFAULT_ORDER } from "../widgets/index"

export const UNIT = 80
export const GAP = 12
export const GRID_COLS = 4
export const GRID_ROWS = 8
export const GRID_WIDTH  = GRID_COLS * UNIT + (GRID_COLS - 1) * GAP // 356
export const GRID_HEIGHT = GRID_ROWS * (UNIT + GAP) - GAP            // 732

export const SIZE_MAP: Record<WidgetSize, { w: number; h: number }> = {
    [WidgetSize.SINGLE]:     { w: 1, h: 1 },
    [WidgetSize.WIDE]:       { w: 2, h: 1 },
    [WidgetSize.TALL]:       { w: 1, h: 2 },
    [WidgetSize.SQUARE]:     { w: 2, h: 2 },
    [WidgetSize.FULL_WIDTH]: { w: 4, h: 1 },
}

// Standardized 3-tier scale (macOS-style). Every footprint maps to one of three
// semantic tiers so the context menu always speaks the same vocabulary
// (Small / Medium / Large) regardless of a widget's concrete geometry:
//   · standard widgets:  1×1 → 2×1 → 2×2
//   · slider widgets:    1×1 → 1×2 → 4×1  (volume, brightness)
export enum SizeTier { SMALL = 0, MEDIUM = 1, LARGE = 2 }

export const SIZE_TIER: Record<WidgetSize, SizeTier> = {
    [WidgetSize.SINGLE]:     SizeTier.SMALL,
    [WidgetSize.WIDE]:       SizeTier.MEDIUM,
    [WidgetSize.TALL]:       SizeTier.MEDIUM,
    [WidgetSize.SQUARE]:     SizeTier.LARGE,
    [WidgetSize.FULL_WIDTH]: SizeTier.LARGE,
}

// WidgetMeta + WIDGET_META are derived from the widget registry (single source
// of truth) and re-exported at the top of this file.

// LayoutEntry is still the consumer-facing format; positions are always computed.
export interface LayoutEntry {
    id: string
    x: number
    y: number
    size?: WidgetSize
}

interface SaveData {
    order: string[]
    sizes: Record<string, WidgetSize>
}

class CCLayoutManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "CCLayoutManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _order: string[] = []
    private _sizes: Record<string, WidgetSize> = {}
    private configPath = `${GLib.get_user_config_dir()}/crystal-shell/cc_layout.json`

    constructor() {
        super()
        this.loadFromDisk()
    }

    private loadFromDisk() {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const raw = JSON.parse(readFile(this.configPath))

                if (Array.isArray(raw)) {
                    // Migrate from old position-based format
                    const entries = (raw as Array<{ id: string; x: number; y: number; size?: WidgetSize }>)
                        .filter(e => WIDGET_META[e.id])
                        .sort((a, b) => a.y * (GRID_COLS + 1) + a.x - (b.y * (GRID_COLS + 1) + b.x))
                    if (entries.length > 0) {
                        this._order = entries.map(e => e.id)
                        this._sizes = {}
                        for (const e of entries) if (e.size) this._sizes[e.id] = e.size
                        return
                    }
                } else {
                    const data = raw as SaveData
                    const order = (data.order ?? []).filter((id: string) => WIDGET_META[id])
                    if (order.length > 0) {
                        this._order = order
                        this._sizes = data.sizes ?? {}
                        return
                    }
                }
            }
        } catch {}
        this._order = [...CC_DEFAULT_ORDER]
        this._sizes = {}
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/crystal-shell`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            writeFile(this.configPath, JSON.stringify({ order: this._order, sizes: this._sizes }, null, 2))
        } catch (e) {
            console.error("[CCLayout] Save failed:", e)
        }
    }

    // Pack widgets left-to-right, top-to-bottom by their order.
    // Each widget is placed at the first fitting cell scanning in reading order.
    private flowPack(order: string[], sizeOf?: (id: string) => WidgetSize): Map<string, { x: number; y: number }> {
        const size = sizeOf ?? ((id: string) => this.effectiveSize(id))
        const result = new Map<string, { x: number; y: number }>()
        const occupied = new Set<string>()
        for (const id of order) {
            const { w, h } = SIZE_MAP[size(id)]
            outer: for (let row = 0; row < GRID_ROWS + 4; row++) {
                for (let col = 0; col <= GRID_COLS - w; col++) {
                    let fits = true
                    check: for (let dy = 0; dy < h; dy++)
                        for (let dx = 0; dx < w; dx++)
                            if (occupied.has(`${col + dx},${row + dy}`)) { fits = false; break check }
                    if (fits) {
                        result.set(id, { x: col, y: row })
                        for (let dy = 0; dy < h; dy++)
                            for (let dx = 0; dx < w; dx++)
                                occupied.add(`${col + dx},${row + dy}`)
                        break outer
                    }
                }
            }
        }
        return result
    }

    // Order-index at which to insert dragId, given the dragged tile's *centre*
    // (cx, cy) in fractional grid-cell units. Midpoint rule: a widget claims the
    // insertion point only once the cursor passes its centre, so hovering the left
    // half of a tile drops before it and the right half drops after — reliable
    // gaps, far-right reachable (returns base.length past the last), and the index
    // changes only at centres (not cell edges), so distant tiles stop twitching.
    private insertIndexAt(dragId: string, cx: number, cy: number): number {
        const base = this._order.filter(id => id !== dragId)
        const pos  = this.flowPack(base)
        for (let i = 0; i < base.length; i++) {
            const p = pos.get(base[i])
            if (!p) continue
            const { w, h } = SIZE_MAP[this.effectiveSize(base[i])]
            // Above this widget's vertical band → insert before it.
            if (cy < p.y) return i
            // Within its band and left of its horizontal centre → insert before it.
            if (cy < p.y + h && cx < p.x + w / 2) return i
        }
        return base.length
    }

    // ── Public API (same surface as before) ─────────────────────────────────

    get layout(): LayoutEntry[] {
        const pos = this.flowPack(this._order)
        return this._order.map(id => ({
            id,
            x: pos.get(id)?.x ?? 0,
            y: pos.get(id)?.y ?? 0,
            size: this._sizes[id],
        }))
    }

    activeIds(): string[] {
        return [...this._order]
    }

    inactiveIds(): string[] {
        const active = new Set(this._order)
        return Object.keys(WIDGET_META).filter(id => !active.has(id))
    }

    effectiveSize(id: string): WidgetSize {
        return this._sizes[id] ?? WIDGET_META[id]?.defaultSize ?? WidgetSize.SINGLE
    }

    // ── Capacity ─────────────────────────────────────────────────────────────
    // Fixed grid: no operation may push content beyond GRID_ROWS.
    private rowsUsed(order: string[], sizeOf: (id: string) => WidgetSize): number {
        const pos = this.flowPack(order, sizeOf)
        let maxRow = 0
        for (const id of order) {
            const p = pos.get(id)
            if (p) maxRow = Math.max(maxRow, p.y + SIZE_MAP[sizeOf(id)].h)
        }
        return maxRow
    }

    // Can `id` (at its current/default size) be added without overflowing the grid?
    canAdd(id: string): boolean {
        if (this._order.includes(id)) return false
        if (!WIDGET_META[id]) return false
        return this.rowsUsed([...this._order, id], (i) => this.effectiveSize(i)) <= GRID_ROWS
    }

    // Can `id` be resized to `newSize` without overflowing the grid?
    canResize(id: string, newSize: WidgetSize): boolean {
        const sizeOf = (i: string) => (i === id ? newSize : this.effectiveSize(i))
        return this.rowsUsed(this._order, sizeOf) <= GRID_ROWS
    }

    // Next size in the cycle that still fits the grid (skips sizes that would
    // overflow, reflowing/displacing neighbours as needed). null = no fitting
    // alternative, so the resize affordance is hidden.
    nextResizeSize(id: string): WidgetSize | null {
        const meta = WIDGET_META[id]
        if (!meta || meta.sizes.length <= 1) return null
        const cur = this.effectiveSize(id)
        const idx = meta.sizes.indexOf(cur)
        for (let step = 1; step < meta.sizes.length; step++) {
            const cand = meta.sizes[(idx + step) % meta.sizes.length]
            if (cand !== cur && this.canResize(id, cand)) return cand
        }
        return null
    }

    resize(id: string, newSize: WidgetSize): boolean {
        this._sizes[id] = newSize
        this.save()
        this.emit("changed")
        return true
    }

    // Hypothetical positions for all widgets if dragId were inserted at the slot
    // its centre (cx, cy in fractional cell units) points to. Widgets behind the
    // insertion point shift down; those before shift up — no gaps.
    previewLayout(dragId: string, cx: number, cy: number): Map<string, { x: number; y: number }> {
        const base = this._order.filter(id => id !== dragId)
        const idx = this.insertIndexAt(dragId, cx, cy)
        base.splice(idx, 0, dragId)
        return this.flowPack(base)
    }

    commitPreview(dragId: string, cx: number, cy: number) {
        const idx = this.insertIndexAt(dragId, cx, cy)
        this._order = this._order.filter(id => id !== dragId)
        this._order.splice(idx, 0, dragId)
        this.save()
        this.emit("changed")
    }

    remove(id: string) {
        this._order = this._order.filter(e => e !== id)
        delete this._sizes[id]
        this.save()
        this.emit("changed")
    }

    // Low-level mutation: never blocks, so default seeding / reconciliation
    // (syncCCLayout) always succeeds. Capacity is enforced at UI entry points
    // via canAdd() (e.g. the Settings "+" button is disabled when full).
    add(id: string) {
        if (this._order.includes(id)) return
        if (!WIDGET_META[id]) return
        this._order.push(id)
        this.save()
        this.emit("changed")
    }

    // Empty cells across the full fixed grid (edit-mode placeholders). Fills up
    // to GRID_ROWS — not just the last occupied row — so the trailing free rows
    // also show their slots, making remaining capacity visible.
    getEmptyCells(): Array<{ x: number; y: number }> {
        const pos = this.flowPack(this._order)
        const occupied = new Set<string>()
        for (const id of this._order) {
            const p = pos.get(id)
            if (!p) continue
            const { w, h } = SIZE_MAP[this.effectiveSize(id)]
            for (let dy = 0; dy < h; dy++)
                for (let dx = 0; dx < w; dx++)
                    occupied.add(`${p.x + dx},${p.y + dy}`)
        }
        const empty: Array<{ x: number; y: number }> = []
        for (let row = 0; row < GRID_ROWS; row++)
            for (let col = 0; col < GRID_COLS; col++)
                if (!occupied.has(`${col},${row}`)) empty.push({ x: col, y: row })
        return empty
    }
}

export const ccLayout = new CCLayoutManager()
export default ccLayout
