import GObject from "gi://GObject"
import { defineSettings } from "./configFile"
import { DEFAULT_PLACEMENT as DEFAULTS, DEFAULT_BAR_MODE, BAR_PRESENCE, BAR_ORDER, CC_FIXED } from "../widgets/index"
import type { BarMode } from "../common/widget-kit/contract"

export interface WidgetPlacement {
    bar: boolean
    cc: boolean
}

// BAR_ORDER (curated bar pill order) and DEFAULTS (first-run placement) are
// derived from the widget registry — see widgets/index.ts.

// Stored in GSettings, `org.nidara.widgets placement` (#573): widget id → (bar, cc).
// The schema default is `{}` and the code's DEFAULTS are merged UNDER what is stored,
// so a widget added to the registry later gets its first-run placement for everybody.
// widgets.json was imported once by migrations/2026-09-14d-widgets-pinned-region.sh.
type StoredPlacement = Record<string, [boolean, boolean]>
// `bar-mode`: widget id → "always" | "active", only where it differs from the widget's
// own default and only for widgets that declare `barActive` (2026-09-27).
const store = defineSettings<{ placement: StoredPlacement, barMode: Record<string, string> }>(
    "widgets", { placement: {}, barMode: {} },
    { barMode: v => Object.values(v).every(m => m === "always" || m === "active") },
)

class WidgetConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WidgetConfigManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _config: Record<string, WidgetPlacement> = {}

    constructor() {
        super()
        this._config = this.load()
        // A placement changed by another process (the Settings app, `gsettings set`).
        // Our own saves come back here too; they rebuild an identical map and the
        // comparison stops them.
        store.subscribe("placement", () => {
            const next = this.load()
            if (JSON.stringify(next) === JSON.stringify(this._config)) return
            this._config = next
            this.emit("changed")
        })
        store.subscribe("barMode", () => this.emit("changed"))
    }

    private load(): Record<string, WidgetPlacement> {
        // A spread is CORRECT here and must stay — this map's keys ARE the data
        // (widget ids), so `DEFAULTS` seeds them rather than enumerating the valid
        // ones; a key-filtering load would drop every widget the shipped defaults
        // don't happen to name, third-party ones included.
        const out: Record<string, WidgetPlacement> = {}
        for (const [id, p] of Object.entries(DEFAULTS)) out[id] = { ...p }
        for (const [id, pair] of Object.entries(store.get("placement"))) {
            if (Array.isArray(pair) && pair.length === 2) out[id] = { bar: pair[0] === true, cc: pair[1] === true }
        }
        // A fixed widget is in the CC whatever was stored — including a `false` saved
        // before it became fixed (2026-09-28), or written by `gsettings set`.
        for (const id of CC_FIXED) if (out[id]) out[id].cc = true
        return out
    }

    private save() {
        const placement: StoredPlacement = {}
        for (const [id, p] of Object.entries(this._config)) placement[id] = [p.bar, p.cc]
        store.set("placement", placement)
    }

    get(id: string): WidgetPlacement {
        return this._config[id] ?? { bar: false, cc: false }
    }

    setBar(id: string, enabled: boolean) {
        if (!this._config[id]) this._config[id] = { bar: false, cc: false }
        if (this._config[id].bar === enabled) return
        this._config[id].bar = enabled
        this.save()
        this.emit("changed")
    }

    /** How the widget shows in the bar, or null for one that cannot say it is active
     *  (it is simply shown or not). A presence indicator is always "active". */
    barMode(id: string): BarMode | null {
        if (BAR_PRESENCE.has(id)) return "active"
        const def = DEFAULT_BAR_MODE[id]
        if (!def) return null
        const stored = store.get("barMode")[id]
        return stored === "always" || stored === "active" ? stored : def
    }

    setBarMode(id: string, mode: BarMode) {
        if (!DEFAULT_BAR_MODE[id] || this.barMode(id) === mode) return
        const next = { ...store.get("barMode") }
        if (mode === DEFAULT_BAR_MODE[id]) delete next[id]
        else next[id] = mode
        store.set("barMode", next)   // → subscribe above → "changed"
    }

    /** The person may pick "Always" / "When active" (contract.ts `barActive`). */
    barModeChoosable(id: string): boolean {
        return id in DEFAULT_BAR_MODE
    }

    /** Always in the CC: moved and resized, never removed (contract.ts `ccFixed`). */
    ccFixed(id: string): boolean {
        return CC_FIXED.has(id)
    }

    setCC(id: string, enabled: boolean) {
        if (!enabled && CC_FIXED.has(id)) return
        if (!this._config[id]) this._config[id] = { bar: false, cc: false }
        if (this._config[id].cc === enabled) return
        this._config[id].cc = enabled
        this.save()
        this.emit("changed")
    }

    // BAR_ORDER already lists every bar-capable widget, so intersecting with it
    // both orders the pills AND drops ids that can no longer render there — a
    // widget that loses its bar variant (media, once the Activity Island took
    // over the player) leaves a `"bar": true` behind in everyone's saved config.
    // Those used to be appended at the end, where they consumed one of the bar's
    // limited icon slots before the render loop skipped them for having no
    // buildBarContent. The saved flag is left untouched: it costs nothing and
    // comes back if the widget ever regains a bar variant.
    barWidgetIds(): string[] {
        const active = new Set(Object.keys(DEFAULTS).filter(id => this._config[id]?.bar))
        return BAR_ORDER.filter(id => active.has(id))
    }

    ccWidgetIds(): string[] {
        return Object.keys(DEFAULTS).filter(id => this._config[id]?.cc)
    }

    allIds(): string[] {
        return Object.keys(DEFAULTS)
    }
}

export const widgetConfig = new WidgetConfigManager()
export default widgetConfig
