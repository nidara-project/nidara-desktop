import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { defineConfig } from "./configFile"

const DEFAULT_TEMP = 4000
const TEMP_MIN = 2700
const TEMP_MAX = 6500

/** `HH:MM`, the only shape `_isInSchedule` can do arithmetic on. A hand-edited
 *  "8pm" is a string like any other, so `loadKnown`'s typeof check waves it
 *  through and `"8pm".split(":")` then yields NaN minutes — a schedule that
 *  never fires and never explains itself. */
const isTime = (v: string) => /^\d{2}:\d{2}$/.test(v)

interface NightLightSettings {
    enabled: boolean
    temperature: number
    scheduleEnabled: boolean
    scheduleFrom: string
    scheduleTo: string
}

const DEFAULTS: NightLightSettings = {
    enabled: false,
    temperature: DEFAULT_TEMP,
    scheduleEnabled: false,
    scheduleFrom: "20:00",
    scheduleTo: "07:00",
}

const config = defineConfig<NightLightSettings>("night-light.json", DEFAULTS, {
    scheduleFrom: isTime,
    scheduleTo: isTime,
    // The value is passed to `hyprsunset -t`. Out of range it is not a crash,
    // it is a screen the user cannot read and a setting whose slider cannot
    // reach the value that put it there.
    temperature: v => Number.isFinite(v) && v >= TEMP_MIN && v <= TEMP_MAX,
})

class NightLightManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NightLightManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _proc: Gio.Subprocess | null = null
    private _applyDebounce = 0
    private _scheduleTimer = 0

    constructor() {
        super()
        // One notification path, not two. Every setter below writes through the
        // store, and the store is what decides a value actually moved — so the
        // signal fires once per real change instead of once per call.
        config.subscribeAll(() => this.emit("changed"))

        if (config.get("scheduleEnabled")) {
            // Always recompute from current time — don't trust the saved
            // `enabled` value, which describes whichever half of the schedule we
            // were in when the shell last ran.
            config.set("enabled", this._isInSchedule())
            this._startScheduleTimer()
        }
        if (config.get("enabled")) this._spawn()
    }

    get enabled()         { return config.get("enabled") }
    get temperature()     { return config.get("temperature") }
    get scheduleEnabled() { return config.get("scheduleEnabled") }
    get scheduleFrom()    { return config.get("scheduleFrom") }
    get scheduleTo()      { return config.get("scheduleTo") }

    setEnabled(val: boolean) {
        config.set("enabled", val)
        if (val) this._spawn()
        else this._kill()
    }

    setTemperature(k: number) {
        config.set("temperature", Math.round(k))
        if (!this.enabled) return
        if (this._applyDebounce > 0) GLib.source_remove(this._applyDebounce)
        this._applyDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._kill()
            this._spawn()
            this._applyDebounce = 0
            return GLib.SOURCE_REMOVE
        })
    }

    setScheduleEnabled(val: boolean) {
        config.set("scheduleEnabled", val)
        if (val) {
            this._checkSchedule()
            this._startScheduleTimer()
        } else {
            this._stopScheduleTimer()
        }
    }

    setScheduleFrom(time: string) {
        config.set("scheduleFrom", time)
        if (this.scheduleEnabled) this._checkSchedule()
    }

    setScheduleTo(time: string) {
        config.set("scheduleTo", time)
        if (this.scheduleEnabled) this._checkSchedule()
    }

    private _isInSchedule(): boolean {
        const now = new Date()
        const nowMins = now.getHours() * 60 + now.getMinutes()
        const [fh, fm] = this.scheduleFrom.split(":").map(Number)
        const [th, tm] = this.scheduleTo.split(":").map(Number)
        const fromMins = fh * 60 + fm
        const toMins   = th * 60 + tm
        // overnight schedule (e.g. 20:00 → 07:00) wraps past midnight
        if (fromMins > toMins) return nowMins >= fromMins || nowMins < toMins
        return nowMins >= fromMins && nowMins < toMins
    }

    private _checkSchedule() {
        const inWindow = this._isInSchedule()
        if (inWindow === this.enabled) return
        config.set("enabled", inWindow)
        if (inWindow) this._spawn(); else this._kill()
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
                ["hyprsunset", "-t", String(this.temperature)],
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

    /** Per-key change notification, for consumers that care about ONE field.
     *  The `changed` signal stays for the ones that re-read several. */
    subscribe = config.subscribe
}

export default new NightLightManager()
