import GObject from "gi://GObject"
import { defineSettings } from "./configFile"

const DEFAULT_TEMP = 4000
const TEMP_MIN = 2700
const TEMP_MAX = 6500

/** `HH:MM`, the only shape `_isInSchedule` can do arithmetic on. A hand-edited
 *  "8pm" is a string like any other, so the schema's type check waves it
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

const config = defineSettings<NightLightSettings>("night-light", DEFAULTS, {
    scheduleFrom: isTime,
    scheduleTo: isTime,
    // The value is passed to `hyprsunset -t`. Out of range it is not a crash,
    // it is a screen the user cannot read and a setting whose slider cannot
    // reach the value that put it there.
    temperature: v => Number.isFinite(v) && v >= TEMP_MIN && v <= TEMP_MAX,
})

/** Is `now` inside the `from`→`to` window? An overnight window (20:00 → 07:00) wraps
 *  past midnight. Pure, so the shell's sync and anything else can ask. */
export function isInSchedule(from: string, to: string, now = new Date()): boolean {
    const nowMins = now.getHours() * 60 + now.getMinutes()
    const [fh, fm] = from.split(":").map(Number)
    const [th, tm] = to.split(":").map(Number)
    const fromMins = fh * 60 + fm
    const toMins   = th * 60 + tm
    if (fromMins > toMins) return nowMins >= fromMins || nowMins < toMins
    return nowMins >= fromMins && nowMins < toMins
}

/**
 * Night light's settings — the store, and nothing that acts on it.
 *
 * ⚠️ Running hyprsunset and the schedule timer are NOT here: they live in
 * core/NightLightSync.ts, started from app.ts, and react to the keys. They used to run
 * in this class's constructor and setters, which meant (a) `gsettings set
 * org.nidara.night-light enabled true` from a terminal changed the switch and not the
 * screen, and (b) any second process importing this module (the Settings app, #571)
 * would spawn a hyprsunset of its own. The setters below only write.
 */
class NightLightManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NightLightManager",
            Signals: { "changed": {} },
        }, this)
    }

    constructor() {
        super()
        // One notification path, not two. Every setter below writes through the
        // store, and the store is what decides a value actually moved — so the
        // signal fires once per real change instead of once per call.
        config.subscribeAll(() => this.emit("changed"))
    }

    get enabled()         { return config.get("enabled") }
    get temperature()     { return config.get("temperature") }
    get scheduleEnabled() { return config.get("scheduleEnabled") }
    get scheduleFrom()    { return config.get("scheduleFrom") }
    get scheduleTo()      { return config.get("scheduleTo") }

    setEnabled(val: boolean)       { config.set("enabled", val) }
    setTemperature(k: number)      { config.set("temperature", Math.round(k)) }
    setScheduleEnabled(val: boolean) { config.set("scheduleEnabled", val) }
    setScheduleFrom(time: string)  { config.set("scheduleFrom", time) }
    setScheduleTo(time: string)    { config.set("scheduleTo", time) }

    /** Per-key change notification, for consumers that care about ONE field.
     *  The `changed` signal stays for the ones that re-read several. */
    subscribe = config.subscribe
}

export default new NightLightManager()
