import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "../../lib/file"
import { DEFAULT_PLACEMENT as DEFAULTS, BAR_ORDER } from "../widgets/index"

export interface WidgetPlacement {
    bar: boolean
    cc: boolean
}

// BAR_ORDER (curated bar pill order) and DEFAULTS (first-run placement) are
// derived from the widget registry — see widgets/index.ts.

class WidgetConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WidgetConfigManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _config: Record<string, WidgetPlacement> = {}
    private configPath = `${GLib.get_user_config_dir()}/nidara/widgets.json`

    constructor() {
        super()
        this._config = this.load()
    }

    private load(): Record<string, WidgetPlacement> {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(this.configPath)) as Record<string, WidgetPlacement>
                // A spread is CORRECT here and must stay — unlike the other config
                // files, this one's keys ARE the data (widget ids), so `DEFAULTS`
                // seeds them rather than enumerating the valid ones. Don't reach for
                // `core/configFile.ts`'s `loadKnown`: it would drop every widget the
                // shipped defaults don't happen to name, third-party ones included.
                return { ...DEFAULTS, ...data }
            }
        } catch {}
        return { ...DEFAULTS }
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/nidara`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            writeFile(this.configPath, JSON.stringify(this._config, null, 2))
        } catch (e) {
            console.error("[WidgetConfig] Save failed:", e)
        }
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

    setCC(id: string, enabled: boolean) {
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
