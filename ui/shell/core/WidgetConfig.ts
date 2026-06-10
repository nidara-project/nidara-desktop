import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"
import { DEFAULT_PLACEMENT as DEFAULTS, BAR_ORDER } from "../widget/widgets/index"

export interface WidgetPlacement {
    bar: boolean
    cc: boolean
}

// BAR_ORDER (curated bar pill order) and DEFAULTS (first-run placement) are
// derived from the widget registry — see widget/widgets/index.ts.

class WidgetConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WidgetConfigManager",
            Signals: { "changed": {} }
        }, this)
    }

    private _config: Record<string, WidgetPlacement> = {}
    private configPath = `${GLib.get_user_config_dir()}/crystal-shell/widgets.json`

    constructor() {
        super()
        this._config = this.load()
    }

    private load(): Record<string, WidgetPlacement> {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(this.configPath)) as Record<string, WidgetPlacement>
                return { ...DEFAULTS, ...data }
            }
        } catch {}
        return { ...DEFAULTS }
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/crystal-shell`
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

    barWidgetIds(): string[] {
        const active = new Set(Object.keys(DEFAULTS).filter(id => this._config[id]?.bar))
        const ordered = BAR_ORDER.filter(id => active.has(id))
        const rest = [...active].filter(id => !BAR_ORDER.includes(id))
        return [...ordered, ...rest]
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
