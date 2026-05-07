import GLib from "gi://GLib"
import Icons from "../../core/Icons"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"
import { WidgetSize } from "./Types"

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

export interface WidgetMeta {
    name: string
    defaultSize: WidgetSize
    sizes: WidgetSize[]
    icon: string
}

export const WIDGET_META: Record<string, WidgetMeta> = {
    brightness:   { name: "Brillo",        defaultSize: WidgetSize.FULL_WIDTH, sizes: [WidgetSize.FULL_WIDTH],                       icon: Icons.sun },
    night_light:  { name: "Luz Nocturna",  defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.moon },
    cpu_memory:   { name: "CPU & Memoria", defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE],                             icon: Icons.cpu },
    media:        { name: "Media",         defaultSize: WidgetSize.SQUARE,     sizes: [WidgetSize.SQUARE],                          icon: Icons.play },
    wifi:         { name: "Wi-Fi",         defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.wifi },
    focus:        { name: "No Molestar",   defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.bellOff },
    ethernet:     { name: "Ethernet",      defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.ethernet },
    bt:           { name: "Bluetooth",     defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE, WidgetSize.WIDE],          icon: Icons.bluetooth },
    dark_mode:    { name: "Apariencia",    defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE, WidgetSize.WIDE],          icon: Icons.moon },
    calculator:   { name: "Calculadora",   defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE],                           icon: Icons.calculator },
    volume:       { name: "Volumen",       defaultSize: WidgetSize.FULL_WIDTH, sizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],       icon: Icons.volumeHigh },
    clipboard:    { name: "Portapapeles",  defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.clipboard },
    screenshot:   { name: "Captura",       defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.camera },
    screenrecord: { name: "Grabación",     defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.record },
    vpn:          { name: "VPN",           defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE, WidgetSize.SINGLE],          icon: Icons.shield },
}

// LayoutEntry is still the consumer-facing format; positions are always computed.
export interface LayoutEntry {
    id: string
    x: number
    y: number
    size?: WidgetSize
}

// Default widget display order — positions are derived by flowPack.
const DEFAULT_ORDER: string[] = [
    "media",
    "wifi",
    "ethernet",
    "focus",
    "dark_mode",
    "bt",
    "volume",
    "cpu_memory",
    "calculator",
]

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
        this._order = [...DEFAULT_ORDER]
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
    private flowPack(order: string[]): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>()
        const occupied = new Set<string>()
        for (const id of order) {
            const { w, h } = SIZE_MAP[this.effectiveSize(id)]
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

    // Find the order-index at which inserting dragId puts it nearest to (snapX, snapY).
    // Uses reading-order key (y * stride + x) to compare positions.
    private insertIdx(dragId: string, snapX: number, snapY: number): number {
        const base = this._order.filter(id => id !== dragId)
        const pos  = this.flowPack(base)
        const snapKey = snapY * (GRID_COLS + 1) + snapX
        for (let i = 0; i < base.length; i++) {
            const p = pos.get(base[i])
            if (p && p.y * (GRID_COLS + 1) + p.x >= snapKey) return i
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

    // Always returns the next size in the cycle — flow layout accommodates any size.
    nextResizeSize(id: string): WidgetSize | null {
        const meta = WIDGET_META[id]
        if (!meta || meta.sizes.length <= 1) return null
        const idx = meta.sizes.indexOf(this.effectiveSize(id))
        return meta.sizes[(idx + 1) % meta.sizes.length]
    }

    resize(id: string, newSize: WidgetSize): boolean {
        this._sizes[id] = newSize
        this.save()
        this.emit("changed")
        return true
    }

    // Returns hypothetical positions for all widgets if dragId were inserted
    // at the position in flow order that puts it nearest to (snapX, snapY).
    // Widgets behind the insertion point shift down; those before shift up — no gaps.
    previewLayout(dragId: string, snapX: number, snapY: number): Map<string, { x: number; y: number }> {
        const base = this._order.filter(id => id !== dragId)
        const basePos = this.flowPack(base)
        const snapKey = snapY * (GRID_COLS + 1) + snapX
        let idx = base.length
        for (let i = 0; i < base.length; i++) {
            const p = basePos.get(base[i])
            if (p && p.y * (GRID_COLS + 1) + p.x >= snapKey) { idx = i; break }
        }
        base.splice(idx, 0, dragId)
        return this.flowPack(base)
    }

    commitPreview(dragId: string, snapX: number, snapY: number) {
        const idx = this.insertIdx(dragId, snapX, snapY)
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

    add(id: string) {
        if (this._order.includes(id)) return
        if (!WIDGET_META[id]) return
        this._order.push(id)
        this.save()
        this.emit("changed")
    }

    getEmptyCells(): Array<{ x: number; y: number }> {
        const pos = this.flowPack(this._order)
        const occupied = new Set<string>()
        let maxRow = 0
        for (const id of this._order) {
            const p = pos.get(id)
            if (!p) continue
            const { w, h } = SIZE_MAP[this.effectiveSize(id)]
            maxRow = Math.max(maxRow, p.y + h)
            for (let dy = 0; dy < h; dy++)
                for (let dx = 0; dx < w; dx++)
                    occupied.add(`${p.x + dx},${p.y + dy}`)
        }
        const empty: Array<{ x: number; y: number }> = []
        for (let row = 0; row < maxRow; row++)
            for (let col = 0; col < GRID_COLS; col++)
                if (!occupied.has(`${col},${row}`)) empty.push({ x: col, y: row })
        return empty
    }
}

export const ccLayout = new CCLayoutManager()
export default ccLayout
