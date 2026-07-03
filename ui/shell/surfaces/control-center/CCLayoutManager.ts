import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"
import { WidgetSize, UNIT, GAP } from "./Types"
import { WIDGET_META, CC_DEFAULT_ORDER } from "../../widgets/index"

export { UNIT, GAP }   // re-exported (defined in the leaf Types) so existing importers are unchanged
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

// Standardized 3-tier scale. Every footprint maps to one of three
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

export interface LayoutEntry {
    id: string
    x: number
    y: number
    size?: WidgetSize
}

interface SaveData {
    positions: Record<string, { x: number; y: number }>
    sizes: Record<string, WidgetSize>
}

type Cell = { x: number; y: number }
type PosMap = Map<string, Cell>

// Free 2D placement with SPATIAL DISPLACEMENT (chosen 2026-06-09 after the user
// rejected both pure flow-pack — "neighbours rearrange for no reason" — and pure
// free placement — "won't push to make room"). Each widget owns an explicit cell.
// Dropping a tile puts it exactly where you point; only the widgets it *overlaps*
// yield, each sliding to the nearest free space (downward-biased, so a tile with a
// gap below it drops into it). Untouched widgets never move — minimal, legible
// displacement. flow-pack survives only to migrate a legacy order array.
class CCLayoutManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "CCLayoutManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _pos: Record<string, Cell> = {}
    private _sizes: Record<string, WidgetSize> = {}
    private configPath = `${GLib.get_user_config_dir()}/nidara/cc_layout.json`

    constructor() {
        super()
        this.loadFromDisk()
    }

    private loadFromDisk() {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const raw = JSON.parse(readFile(this.configPath))

                if (Array.isArray(raw)) {
                    // Oldest format: [{id,x,y,size}] — already positional.
                    const entries = (raw as Array<LayoutEntry>).filter(e => WIDGET_META[e.id])
                    if (entries.length > 0) {
                        this._pos = {}; this._sizes = {}
                        for (const e of entries) {
                            this._pos[e.id] = { x: e.x | 0, y: e.y | 0 }
                            if (e.size) this._sizes[e.id] = e.size
                        }
                        this.normalize(); return
                    }
                } else if (raw && typeof raw === "object" && raw.positions) {
                    const sizes = (raw.sizes ?? {}) as Record<string, WidgetSize>
                    this._pos = {}; this._sizes = {}
                    for (const id of Object.keys(raw.positions))
                        if (WIDGET_META[id]) this._pos[id] = { x: raw.positions[id].x | 0, y: raw.positions[id].y | 0 }
                    for (const id of Object.keys(sizes))
                        if (WIDGET_META[id]) this._sizes[id] = sizes[id]
                    if (Object.keys(this._pos).length > 0) { this.normalize(); return }
                } else if (raw && typeof raw === "object" && raw.order) {
                    // Legacy order-based format → flow-pack once into positions.
                    const order = ((raw.order ?? []) as string[]).filter(id => WIDGET_META[id])
                    this._sizes = (raw.sizes ?? {}) as Record<string, WidgetSize>
                    if (order.length > 0) { this.seedFromOrder(order); return }
                }
            }
        } catch {}
        this._sizes = {}
        this.seedFromOrder([...CC_DEFAULT_ORDER])
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/nidara`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            const data: SaveData = { positions: this._pos, sizes: this._sizes }
            writeFile(this.configPath, JSON.stringify(data, null, 2))
        } catch (e) {
            console.error("[CCLayout] Save failed:", e)
        }
    }

    // ── Geometry helpers ───────────────────────────────────────────────────────
    footprint(id: string): { w: number; h: number } {
        return SIZE_MAP[this.effectiveSize(id)]
    }

    private markOcc(occ: Set<string>, x: number, y: number, w: number, h: number) {
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                occ.add(`${x + dx},${y + dy}`)
    }

    private cellsFree(occ: Set<string>, x: number, y: number, w: number, h: number): boolean {
        if (x < 0 || y < 0 || x + w > GRID_COLS || y + h > GRID_ROWS) return false
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                if (occ.has(`${x + dx},${y + dy}`)) return false
        return true
    }

    private occupiedSet(ignoreId?: string): Set<string> {
        const occ = new Set<string>()
        for (const id of Object.keys(this._pos)) {
            if (id === ignoreId) continue
            const { w, h } = this.footprint(id)
            const { x, y } = this._pos[id]
            this.markOcc(occ, x, y, w, h)
        }
        return occ
    }

    private firstFree(occ: Set<string>, w: number, h: number): Cell | null {
        for (let y = 0; y <= GRID_ROWS - h; y++)
            for (let x = 0; x <= GRID_COLS - w; x++)
                if (this.cellsFree(occ, x, y, w, h)) return { x, y }
        return null
    }

    // Free cell that fits w×h, picked with GRAVITY: a tile displaced by a drop falls
    // into the gap below it. Tiers — any cell below the origin row beats any cell on
    // the same row, which beats any cell above; within a tier, nearest (rows then
    // columns) wins. So "drop onto a tile that has space beneath" slides it straight
    // down rather than sideways, and sideways/upward only happen as fallbacks.
    private nearestFree(occ: Set<string>, w: number, h: number, from: Cell): Cell | null {
        let best: Cell | null = null
        let bestCost = Infinity
        for (let y = 0; y <= GRID_ROWS - h; y++) {
            for (let x = 0; x <= GRID_COLS - w; x++) {
                if (!this.cellsFree(occ, x, y, w, h)) continue
                const tier = y > from.y ? 0 : (y === from.y ? 1 : 2)
                const dist = Math.abs(y - from.y) * (GRID_COLS + 1) + Math.abs(x - from.x)
                const cost = tier * 10000 + dist
                if (cost < bestCost) { bestCost = cost; best = { x, y } }
            }
        }
        return best
    }

    private overlaps(a: Cell, af: { w: number; h: number }, b: Cell, bf: { w: number; h: number }): boolean {
        return a.x < b.x + bf.w && a.x + af.w > b.x && a.y < b.y + bf.h && a.y + af.h > b.y
    }

    private flowPack(order: string[]): PosMap {
        const result: PosMap = new Map()
        const occ = new Set<string>()
        for (const id of order) {
            const { w, h } = SIZE_MAP[this.effectiveSize(id)]
            const cell = this.firstFree(occ, w, h)
            if (cell) { result.set(id, cell); this.markOcc(occ, cell.x, cell.y, w, h) }
        }
        return result
    }

    private seedFromOrder(order: string[]) {
        const packed = this.flowPack(order)
        this._pos = {}
        for (const id of order) {
            const p = packed.get(id)
            if (p) this._pos[id] = { x: p.x, y: p.y }
        }
        this.normalize()
    }

    // Repair loaded data: clamp in-bounds, relocate overlaps to first free cell.
    private normalize() {
        const ids = Object.keys(this._pos).sort((a, b) =>
            (this._pos[a].y - this._pos[b].y) || (this._pos[a].x - this._pos[b].x))
        const occ = new Set<string>()
        const next: Record<string, Cell> = {}
        for (const id of ids) {
            const { w, h } = this.footprint(id)
            let { x, y } = this._pos[id]
            if (!this.cellsFree(occ, x, y, w, h)) {
                const cell = this.firstFree(occ, w, h)
                if (!cell) continue
                x = cell.x; y = cell.y
            }
            next[id] = { x, y }
            this.markOcc(occ, x, y, w, h)
        }
        this._pos = next
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    get layout(): LayoutEntry[] {
        return Object.keys(this._pos)
            .map(id => ({ id, x: this._pos[id].x, y: this._pos[id].y, size: this._sizes[id] }))
            .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    }

    activeIds(): string[] { return Object.keys(this._pos) }

    inactiveIds(): string[] {
        const active = new Set(Object.keys(this._pos))
        return Object.keys(WIDGET_META).filter(id => !active.has(id))
    }

    effectiveSize(id: string): WidgetSize {
        return this._sizes[id] ?? WIDGET_META[id]?.defaultSize ?? WidgetSize.SINGLE
    }

    // ── Drag placement with displacement ─────────────────────────────────────
    // Resolve the full layout if dragId were dropped at cell (tx,ty): dragId takes
    // the target, every widget it overlaps slides to its nearest free cell (others
    // stay put). Returns null if the target is off-grid or a displaced tile can't
    // fit anywhere (caller treats null as an invalid drop).
    private resolvePlacement(dragId: string, tx: number, ty: number): PosMap | null {
        const { w, h } = this.footprint(dragId)
        if (tx < 0 || ty < 0 || tx + w > GRID_COLS || ty + h > GRID_ROWS) return null

        const target: Cell = { x: tx, y: ty }
        const conflicts: string[] = []
        for (const id of Object.keys(this._pos)) {
            if (id === dragId) continue
            if (this.overlaps(target, { w, h }, this._pos[id], this.footprint(id)))
                conflicts.push(id)
        }

        const result: PosMap = new Map()
        for (const id of Object.keys(this._pos)) result.set(id, { ...this._pos[id] })
        result.set(dragId, target)
        if (conflicts.length === 0) return result

        // Occupancy = everyone fixed (not drag, not a conflict) + drag's new cells.
        const occ = new Set<string>()
        this.markOcc(occ, tx, ty, w, h)
        for (const id of Object.keys(this._pos))
            if (id !== dragId && !conflicts.includes(id)) {
                const f = this.footprint(id)
                this.markOcc(occ, this._pos[id].x, this._pos[id].y, f.w, f.h)
            }

        // SWAP: dropping a tile onto a single same-size tile trades places — the
        // displaced one takes the dragged tile's vacated origin instead of falling to
        // a free hole. Only for one equal-footprint conflict; anything else uses
        // gravity below. (The origin is free in occ since the drag tile left it.)
        const origin = this._pos[dragId]
        if (conflicts.length === 1) {
            const other = conflicts[0]
            const of = this.footprint(other)
            if (of.w === w && of.h === h && this.cellsFree(occ, origin.x, origin.y, w, h)) {
                result.set(other, { x: origin.x, y: origin.y })
                return result
            }
        }

        // Slide each displaced tile to its nearest free spot (downward-biased).
        const order = conflicts.sort((a, b) =>
            (this._pos[a].y - this._pos[b].y) || (this._pos[a].x - this._pos[b].x))
        for (const id of order) {
            const f = this.footprint(id)
            const cell = this.nearestFree(occ, f.w, f.h, this._pos[id])
            if (!cell) return null
            result.set(id, cell)
            this.markOcc(occ, cell.x, cell.y, f.w, f.h)
        }
        return result
    }

    // Preview positions for the whole grid (null = invalid drop). Caller animates.
    previewLayout(dragId: string, tx: number, ty: number): PosMap | null {
        return this.resolvePlacement(dragId, tx, ty)
    }

    // Commit a drop; false = invalid (caller reverts).
    commitPreview(dragId: string, tx: number, ty: number): boolean {
        const resolved = this.resolvePlacement(dragId, tx, ty)
        if (!resolved) return false
        const next: Record<string, Cell> = {}
        for (const [id, c] of resolved) next[id] = { x: c.x, y: c.y }
        this._pos = next
        this.save()
        this.emit("changed")
        return true
    }

    findFreeCell(id: string, size?: WidgetSize): Cell | null {
        const { w, h } = size ? SIZE_MAP[size] : this.footprint(id)
        return this.firstFree(this.occupiedSet(id), w, h)
    }

    // ── Capacity / resize ──────────────────────────────────────────────────────
    canAdd(id: string): boolean {
        if (this._pos[id]) return false
        if (!WIDGET_META[id]) return false
        return !!this.findFreeCell(id)
    }

    canResize(id: string, newSize: WidgetSize): boolean {
        const cur = this._pos[id]
        if (!cur) return false
        const { w, h } = SIZE_MAP[newSize]
        if (this.cellsFree(this.occupiedSet(id), cur.x, cur.y, w, h)) return true
        return !!this.findFreeCell(id, newSize)
    }

    resize(id: string, newSize: WidgetSize): boolean {
        const cur = this._pos[id]
        if (!cur) return false
        const { w, h } = SIZE_MAP[newSize]
        if (this.cellsFree(this.occupiedSet(id), cur.x, cur.y, w, h)) {
            this._sizes[id] = newSize
        } else {
            const cell = this.findFreeCell(id, newSize)
            if (!cell) return false
            this._sizes[id] = newSize
            this._pos[id] = cell
        }
        this.save()
        this.emit("changed")
        return true
    }

    remove(id: string) {
        delete this._pos[id]
        delete this._sizes[id]
        this.save()
        this.emit("changed")
    }

    add(id: string) {
        if (this._pos[id]) return
        if (!WIDGET_META[id]) return
        const cell = this.findFreeCell(id)
        if (!cell) return
        this._pos[id] = cell
        this.save()
        this.emit("changed")
    }

    getEmptyCells(): Cell[] {
        const occ = this.occupiedSet()
        const empty: Cell[] = []
        for (let row = 0; row < GRID_ROWS; row++)
            for (let col = 0; col < GRID_COLS; col++)
                if (!occ.has(`${col},${row}`)) empty.push({ x: col, y: row })
        return empty
    }
}

export const ccLayout = new CCLayoutManager()
export default ccLayout
