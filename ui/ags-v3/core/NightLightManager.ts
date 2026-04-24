import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/night-light.json`
const DEFAULT_TEMP = 4000

class NightLightManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NightLightManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _enabled = false
    private _temperature = DEFAULT_TEMP
    private _proc: Gio.Subprocess | null = null
    private _applyDebounce = 0

    constructor() {
        super()
        this._load()
        if (this._enabled) this._spawn()
    }

    get enabled() { return this._enabled }
    get temperature() { return this._temperature }

    setEnabled(val: boolean) {
        this._enabled = val
        if (val) this._spawn()
        else this._kill()
        this._save()
        this.emit("changed")
    }

    setTemperature(k: number) {
        this._temperature = Math.round(k)
        this._save()
        this.emit("changed")
        if (!this._enabled) return
        if (this._applyDebounce > 0) GLib.source_remove(this._applyDebounce)
        this._applyDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._kill()
            this._spawn()
            this._applyDebounce = 0
            return GLib.SOURCE_REMOVE
        })
    }

    private _spawn() {
        this._kill()
        try {
            this._proc = Gio.Subprocess.new(
                ["hyprsunset", "-t", String(this._temperature)],
                Gio.SubprocessFlags.NONE,
            )
        } catch (e) {
            console.error("[NightLight] Failed to start hyprsunset:", e)
            this._proc = null
        }
    }

    private _kill() {
        if (this._proc) {
            try { this._proc.force_exit() } catch (_) {}
            this._proc = null
        }
    }

    private _save() {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify({ enabled: this._enabled, temperature: this._temperature }, null, 2))
    }

    private _load() {
        try {
            if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(CONFIG_PATH))
                this._enabled = data.enabled ?? false
                this._temperature = data.temperature ?? DEFAULT_TEMP
            }
        } catch (_) {}
    }
}

export default new NightLightManager()
