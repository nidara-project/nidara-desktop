import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"

export interface WidgetPlacement {
    bar: boolean
    cc: boolean
}

const DEFAULTS: Record<string, WidgetPlacement> = {
    cpu_memory: { bar: true,  cc: true  },
    volume:     { bar: false, cc: true  },
    wifi:       { bar: false, cc: true  },
    ethernet:   { bar: false, cc: true  },
    bt:         { bar: false, cc: true  },
    media:      { bar: false, cc: true  },
    dark_mode:  { bar: false, cc: true  },
    focus:      { bar: false, cc: true  },
    calculator: { bar: false, cc: true  },
    clipboard:    { bar: false, cc: true  },
    screenshot:   { bar: false, cc: true  },
    screenrecord: { bar: false, cc: true  },
    vpn:          { bar: false, cc: true  },
}

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
        return Object.keys(DEFAULTS).filter(id => this._config[id]?.bar)
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
