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
    sizes: WidgetSize[]   // Available sizes to cycle through
    icon: string
}

export const WIDGET_META: Record<string, WidgetMeta> = {
    cpu_memory:  { name: "CPU & Memoria", defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE],                              icon: "computer-symbolic" },
    media:       { name: "Media",         defaultSize: WidgetSize.SQUARE,     sizes: [WidgetSize.SQUARE, WidgetSize.WIDE],           icon: Icons.play },
    wifi:        { name: "Wi-Fi",         defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE],                              icon: "network-wireless-symbolic" },
    focus:       { name: "No Molestar",   defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE],                              icon: Icons.bellOff },
    ethernet:    { name: "Ethernet",      defaultSize: WidgetSize.WIDE,       sizes: [WidgetSize.WIDE],                              icon: "network-wired-symbolic" },
    bt:          { name: "Bluetooth",     defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE, WidgetSize.WIDE],           icon: "bluetooth-active-symbolic" },
    dark_mode:   { name: "Apariencia",    defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE, WidgetSize.WIDE],           icon: "weather-clear-night-symbolic" },
    calculator:  { name: "Calculadora",   defaultSize: WidgetSize.SINGLE,     sizes: [WidgetSize.SINGLE],                            icon: "accessories-calculator-symbolic" },
    volume:      { name: "Volumen",       defaultSize: WidgetSize.FULL_WIDTH, sizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],        icon: Icons.volumeHigh },
}

export interface LayoutEntry {
    id: string
    x: number
    y: number
    size?: WidgetSize   // Overrides defaultSize when set
}

const DEFAULT_LAYOUT: LayoutEntry[] = [
    { id: "cpu_memory",  x: 2, y: 3 },
    { id: "media",       x: 0, y: 0 },
    { id: "focus",       x: 0, y: 2 },
    { id: "wifi",        x: 2, y: 0 },
    { id: "ethernet",    x: 2, y: 1 },
    { id: "bt",          x: 3, y: 1 },
    { id: "dark_mode",   x: 2, y: 2 },
    { id: "calculator",  x: 3, y: 2 },
    { id: "volume",      x: 0, y: 3 },
]

class CCLayoutManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "CCLayoutManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _layout: LayoutEntry[] = []
    private configPath = `${GLib.get_user_config_dir()}/crystal-shell/cc_layout.json`

    constructor() {
        super()
        this._layout = this.loadFromDisk()
    }

    private loadFromDisk(): LayoutEntry[] {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(this.configPath)) as LayoutEntry[]
                const valid = data.filter(e => WIDGET_META[e.id])
                if (valid.length > 0) return valid
            }
        } catch {}
        return [...DEFAULT_LAYOUT]
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/crystal-shell`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            writeFile(this.configPath, JSON.stringify(this._layout, null, 2))
        } catch (e) {
            console.error("[CCLayout] Save failed:", e)
        }
    }

    get layout(): LayoutEntry[] {
        return [...this._layout]
    }

    activeIds(): string[] {
        return this._layout.map(e => e.id)
    }

    inactiveIds(): string[] {
        const active = new Set(this.activeIds())
        return Object.keys(WIDGET_META).filter(id => !active.has(id))
    }

    effectiveSize(id: string): WidgetSize {
        const entry = this._layout.find(e => e.id === id)
        return entry?.size ?? WIDGET_META[id]?.defaultSize ?? WidgetSize.SINGLE
    }

    // Returns the next available size that fits at current position, or null
    nextResizeSize(id: string): WidgetSize | null {
        const meta = WIDGET_META[id]
        if (!meta || meta.sizes.length <= 1) return null
        const current = this.effectiveSize(id)
        const idx = meta.sizes.indexOf(current)
        for (let i = 1; i < meta.sizes.length; i++) {
            const candidate = meta.sizes[(idx + i) % meta.sizes.length]
            if (this.canFit(id, candidate)) return candidate
        }
        return null
    }

    private canFit(id: string, size: WidgetSize): boolean {
        const entry = this._layout.find(e => e.id === id)
        if (!entry) return false
        const { w, h } = SIZE_MAP[size]
        if (entry.x + w > GRID_COLS) return false
        const occ = this.buildOccupancyExcluding(id)
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                if (occ.has(`${entry.x + dx},${entry.y + dy}`)) return false
        return true
    }

    resize(id: string, newSize: WidgetSize): boolean {
        if (!this.canFit(id, newSize)) return false
        const entry = this._layout.find(e => e.id === id)
        if (!entry) return false
        entry.size = newSize
        this.save()
        this.emit("changed")
        return true
    }

    move(id: string, newX: number, newY: number): boolean {
        const entry = this._layout.find(e => e.id === id)
        if (!entry) return false
        const size = this.effectiveSize(id)
        const { w, h } = SIZE_MAP[size]
        if (newX < 0 || newY < 0 || newX + w > GRID_COLS) return false
        const occ = this.buildOccupancyExcluding(id)
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                if (occ.has(`${newX + dx},${newY + dy}`)) return false
        if (entry.x === newX && entry.y === newY) return true  // no-op
        entry.x = newX
        entry.y = newY
        this.save()
        this.emit("changed")
        return true
    }

    remove(id: string) {
        this._layout = this._layout.filter(e => e.id !== id)
        this.save()
        this.emit("changed")
    }

    add(id: string) {
        if (this._layout.find(e => e.id === id)) return
        const meta = WIDGET_META[id]
        if (!meta) return
        const { w, h } = SIZE_MAP[meta.defaultSize]
        const pos = this.findFreeSlot(w, h)
        if (!pos) return
        this._layout.push({ id, x: pos.x, y: pos.y })
        this.save()
        this.emit("changed")
    }

    private buildOccupancyExcluding(excludeId?: string): Set<string> {
        const occ = new Set<string>()
        for (const entry of this._layout) {
            if (entry.id === excludeId) continue
            const size = this.effectiveSize(entry.id)
            const { w, h } = SIZE_MAP[size]
            for (let dy = 0; dy < h; dy++)
                for (let dx = 0; dx < w; dx++)
                    occ.add(`${entry.x + dx},${entry.y + dy}`)
        }
        return occ
    }

    private findFreeSlot(w: number, h: number): { x: number; y: number } | null {
        const occ = this.buildOccupancyExcluding()
        for (let row = 0; row < 20; row++) {
            for (let col = 0; col <= GRID_COLS - w; col++) {
                let fits = true
                search: for (let dy = 0; dy < h; dy++)
                    for (let dx = 0; dx < w; dx++)
                        if (occ.has(`${col + dx},${row + dy}`)) { fits = false; break search }
                if (fits) return { x: col, y: row }
            }
        }
        return null
    }

    getEmptyCells(): Array<{ x: number; y: number }> {
        const occ = this.buildOccupancyExcluding()
        const empty: Array<{ x: number; y: number }> = []
        for (let row = 0; row < GRID_ROWS; row++)
            for (let col = 0; col < GRID_COLS; col++)
                if (!occ.has(`${col},${row}`)) empty.push({ x: col, y: row })
        return empty
    }
}

export const ccLayout = new CCLayoutManager()
export default ccLayout
