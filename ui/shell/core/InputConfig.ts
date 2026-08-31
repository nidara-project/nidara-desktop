import GObject from "gi://GObject"
import GLib from "gi://GLib"
import hs from "./HyprlandState"

// Build a `hl.config({ input = { … } })` expression from a keyword-style option
// path ("input:touchpad:tap_to_click") + value, for `hyprctl eval`. String values
// are quoted; numbers/booleans pass through. The Lua parser rejects `hyprctl
// keyword`, so this is the only way to apply input options live.
function inputConfigEval(option: string, value: string | number): string {
    const path = option.replace(/^input:/, "").split(":")
    const lit = typeof value === "string" ? `"${value}"` : String(value)
    let inner = `${path[path.length - 1]} = ${lit}`
    for (let i = path.length - 2; i >= 0; i--) inner = `${path[i]} = { ${inner} }`
    return `hl.config({ input = { ${inner} } })`
}

class InputConfig extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "InputConfigManager",
            Signals: {
                changed: {},
            },
        }, this)
    }

    private _pointerSpeed = 0.0
    private _accelProfile = "adaptive"
    private _mouseNaturalScroll = false
    private _touchpadNaturalScroll = false
    private _touchpadTap = true
    private _numlockOnBoot = false
    private _kbLayout = "us"
    private _kbVariant = ""
    private _kbRepeatDelay = 600
    private _kbRepeatRate = 25
    private _initPromise: Promise<void> | null = null

    constructor() {
        super()
        this._initPromise = this.syncFromHyprland()
        // Re-read the effective input options whenever Hyprland reloads its config
        // (e.g. the user edits hyprland-user.lua and runs `hyprctl reload`). Without
        // this, the next setX() would rewrite nidara-settings.lua from our stale
        // in-memory state and clobber the user's external change.
        hs.connect("config-reloaded", () => {
            this._initPromise = this.syncFromHyprland()
        })
    }

    get pointerSpeed() { return this._pointerSpeed }
    get accelProfile() { return this._accelProfile }
    get mouseNaturalScroll() { return this._mouseNaturalScroll }
    get touchpadNaturalScroll() { return this._touchpadNaturalScroll }
    get touchpadTap() { return this._touchpadTap }
    get numlockOnBoot() { return this._numlockOnBoot }
    get kbLayout() { return this._kbLayout }
    get kbVariant() { return this._kbVariant }
    get kbRepeatDelay() { return this._kbRepeatDelay }
    get kbRepeatRate() { return this._kbRepeatRate }

    // single door to hyprctl).
    //
    // Every read passes the CURRENT field as its fallback, so an option that cannot
    // be read leaves this object as it found it. That matters more here than in a
    // one-off read: `applyAndSave` rewrites the whole of nidara-settings.lua from
    // these fields, so anything this method gets wrong is not just displayed wrong,
    // it is persisted and applied on the next change to any input setting.
    //
    // ⚠️ The typed readers are not a style preference. Reading a bool option off the
    // raw JSON as `.int === 1` is `undefined === 1` — false for every boolean, with
    // nothing reporting it (#338). `getOptionBoolAsync` cannot make that mistake.
    private async syncFromHyprland(): Promise<void> {
        this._pointerSpeed = await hs.getOptionFloatAsync("input:sensitivity", this._pointerSpeed)
        this._accelProfile = await hs.getOptionStrAsync("input:accel_profile", this._accelProfile)

        this._mouseNaturalScroll = await hs.getOptionBoolAsync("input:natural_scroll", this._mouseNaturalScroll)
        this._touchpadNaturalScroll = await hs.getOptionBoolAsync("input:touchpad:natural_scroll", this._touchpadNaturalScroll)
        this._touchpadTap = await hs.getOptionBoolAsync("input:touchpad:tap_to_click", this._touchpadTap)
        this._numlockOnBoot = await hs.getOptionBoolAsync("input:numlock_by_default", this._numlockOnBoot)

        this._kbLayout = await hs.getOptionStrAsync("input:kb_layout", this._kbLayout)
        this._kbVariant = await hs.getOptionStrAsync("input:kb_variant", this._kbVariant)
        this._kbRepeatDelay = await hs.getOptionIntAsync("input:repeat_delay", this._kbRepeatDelay)
        this._kbRepeatRate = await hs.getOptionIntAsync("input:repeat_rate", this._kbRepeatRate)

        this.emit("changed")
    }

    private async applyAndSave(option: string, value: string | number, applyChange?: () => void) {
        if (this._initPromise) {
            await this._initPromise
        }
        if (applyChange) applyChange()

        // 1. Live apply. The config uses Hyprland's Lua parser, which REJECTS
        // `hyprctl keyword` ("Use eval.") — so live changes go through eval.
        hs.evalLua(inputConfigEval(option, value))

        // 2. Save to persistent UI-owned file
        const configPath = GLib.build_filenamev([GLib.get_home_dir(), ".config", "nidara", "nidara-settings.lua"])

        // Build the contents of the UI-managed override file
        const contents = `\
-- NIDARA SHELL SETTINGS
-- Auto-generated by the Nidara Settings UI. Do not edit manually.
hl.config({
    input = {
        sensitivity        = ${this._pointerSpeed.toFixed(2)},
        accel_profile      = "${this._accelProfile}",
        natural_scroll     = ${this._mouseNaturalScroll},
        numlock_by_default = ${this._numlockOnBoot},
        kb_layout          = "${this._kbLayout}",
        kb_variant         = "${this._kbVariant}",
        repeat_delay       = ${this._kbRepeatDelay},
        repeat_rate        = ${this._kbRepeatRate},
        touchpad = {
            natural_scroll   = ${this._touchpadNaturalScroll},
            tap_to_click = ${this._touchpadTap},
        },
    },
})`

        try {
            const targetDir = GLib.path_get_dirname(configPath)
            if (!GLib.file_test(targetDir, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(targetDir, 0o755)
            }
            GLib.file_set_contents(configPath, contents)
        } catch (e) {
            console.error("Failed to write nidara settings:", e)
        }

        this.emit("changed")
    }

    setPointerSpeed(val: number) {
        return this.applyAndSave("input:sensitivity", val, () => {
            this._pointerSpeed = val
        })
    }

    setAccelProfile(val: string) {
        return this.applyAndSave("input:accel_profile", val, () => {
            this._accelProfile = val
        })
    }

    setMouseNaturalScroll(val: boolean) {
        return this.applyAndSave("input:natural_scroll", val ? 1 : 0, () => {
            this._mouseNaturalScroll = val
        })
    }

    setTouchpadNaturalScroll(val: boolean) {
        return this.applyAndSave("input:touchpad:natural_scroll", val ? 1 : 0, () => {
            this._touchpadNaturalScroll = val
        })
    }

    setTouchpadTap(val: boolean) {
        return this.applyAndSave("input:touchpad:tap_to_click", val ? 1 : 0, () => {
            this._touchpadTap = val
        })
    }

    setNumlockOnBoot(val: boolean) {
        return this.applyAndSave("input:numlock_by_default", val ? 1 : 0, () => {
            this._numlockOnBoot = val
        })
    }

    setKbRepeatDelay(val: number) {
        const delay = Math.round(val)
        return this.applyAndSave("input:repeat_delay", delay, () => {
            this._kbRepeatDelay = delay
        })
    }

    setKbRepeatRate(val: number) {
        const rate = Math.round(val)
        return this.applyAndSave("input:repeat_rate", rate, () => {
            this._kbRepeatRate = rate
        })
    }

    setKbLayout(layout: string, variant = "") {
        return this.applyAndSave("input:kb_layout", layout, () => {
            this._kbLayout = layout
            this._kbVariant = variant
            hs.evalLua(`hl.config({ input = { kb_layout = "${layout}", kb_variant = "${variant}" } })`)
        })
    }
}

const inputConfig = new InputConfig()
export default inputConfig
