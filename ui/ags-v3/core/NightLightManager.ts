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
    private _scheduleEnabled = false
    private _scheduleFrom = "20:00"
    private _scheduleTo   = "07:00"
    private _proc: Gio.Subprocess | null = null
    private _applyDebounce = 0
    private _scheduleTimer = 0

    constructor() {
        super()
        this._load()
        if (this._scheduleEnabled) {
            this._checkSchedule()
            this._startScheduleTimer()
        } else if (this._enabled) {
            this._spawn()
        }
    }

    get enabled()         { return this._enabled }
    get temperature()     { return this._temperature }
    get scheduleEnabled() { return this._scheduleEnabled }
    get scheduleFrom()    { return this._scheduleFrom }
    get scheduleTo()      { return this._scheduleTo }

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

    setScheduleEnabled(val: boolean) {
        this._scheduleEnabled = val
        if (val) {
            this._checkSchedule()
            this._startScheduleTimer()
        } else {
            this._stopScheduleTimer()
        }
        this._save()
        this.emit("changed")
    }

    setScheduleFrom(time: string) {
        this._scheduleFrom = time
        if (this._scheduleEnabled) this._checkSchedule()
        this._save()
        this.emit("changed")
    }

    setScheduleTo(time: string) {
        this._scheduleTo = time
        if (this._scheduleEnabled) this._checkSchedule()
        this._save()
        this.emit("changed")
    }

    private _isInSchedule(): boolean {
        const now = new Date()
        const nowMins = now.getHours() * 60 + now.getMinutes()
        const [fh, fm] = this._scheduleFrom.split(":").map(Number)
        const [th, tm] = this._scheduleTo.split(":").map(Number)
        const fromMins = fh * 60 + fm
        const toMins   = th * 60 + tm
        // overnight schedule (e.g. 20:00 → 07:00) wraps past midnight
        if (fromMins > toMins) return nowMins >= fromMins || nowMins < toMins
        return nowMins >= fromMins && nowMins < toMins
    }

    private _checkSchedule() {
        const inWindow = this._isInSchedule()
        if (inWindow === this._enabled) return
        this._enabled = inWindow
        if (inWindow) this._spawn(); else this._kill()
        this.emit("changed")
    }

    private _startScheduleTimer() {
        if (this._scheduleTimer > 0) return
        this._scheduleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60_000, () => {
            this._checkSchedule()
            return GLib.SOURCE_CONTINUE
        })
    }

    private _stopScheduleTimer() {
        if (this._scheduleTimer > 0) {
            GLib.source_remove(this._scheduleTimer)
            this._scheduleTimer = 0
        }
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
        writeFile(CONFIG_PATH, JSON.stringify({
            enabled:         this._enabled,
            temperature:     this._temperature,
            scheduleEnabled: this._scheduleEnabled,
            scheduleFrom:    this._scheduleFrom,
            scheduleTo:      this._scheduleTo,
        }, null, 2))
    }

    private _load() {
        try {
            if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                const d = JSON.parse(readFile(CONFIG_PATH))
                this._enabled         = d.enabled         ?? false
                this._temperature     = d.temperature     ?? DEFAULT_TEMP
                this._scheduleEnabled = d.scheduleEnabled ?? false
                this._scheduleFrom    = d.scheduleFrom    ?? "20:00"
                this._scheduleTo      = d.scheduleTo      ?? "07:00"
            }
        } catch (_) {}
    }
}

export default new NightLightManager()
