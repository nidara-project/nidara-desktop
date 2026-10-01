import GObject from "gi://GObject"
import compositor, { settings, type InputKey, type InputSettings } from "./CompositorState"

/**
 * The input options the compositor owns and Settings configures — on Hyprland or Hyalo,
 * through `settings` (CompositorState.ts). This module is the cache Settings reads and the
 * door it writes through; where each option lives, how it is applied and the file it is
 * kept in are the backend's (core/hyprland-settings.ts, core/hyalo-settings.ts).
 *
 * The state is a CACHE of the compositor's effective values, not the source: the user's
 * own file (`hyprland-user.lua`, `hyalo.toml`) can override any of them, and the
 * compositor is the only one that computes the sum.
 */
const DEFAULTS: InputSettings = {
    pointerSpeed: 0.0,
    accelProfile: "adaptive",
    mouseNaturalScroll: false,
    numlockOnBoot: false,
    kbLayout: "us",
    kbVariant: "",
    kbRepeatDelay: 600,
    kbRepeatRate: 25,
    touchpadNaturalScroll: false,
    touchpadTap: true,
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

    private state: InputSettings = { ...DEFAULTS }

    private _initPromise: Promise<void> | null = null

    constructor() {
        super()
        this._initPromise = this.sync()
        // Re-read the effective options whenever the compositor reloads its config (the
        // user edited their own file). Without this, the next setX() on Hyprland would
        // rewrite nidara-settings.lua from stale state and clobber the user's change.
        compositor.connect("config-reloaded", () => {
            this._initPromise = this.sync()
        })
    }

    get pointerSpeed() { return this.state.pointerSpeed }
    get accelProfile() { return this.state.accelProfile }
    get mouseNaturalScroll() { return this.state.mouseNaturalScroll }
    get touchpadNaturalScroll() { return this.state.touchpadNaturalScroll }
    get touchpadTap() { return this.state.touchpadTap }
    get numlockOnBoot() { return this.state.numlockOnBoot }
    get kbLayout() { return this.state.kbLayout }
    get kbVariant() { return this.state.kbVariant }
    get kbRepeatDelay() { return this.state.kbRepeatDelay }
    get kbRepeatRate() { return this.state.kbRepeatRate }

    /** Every option's EFFECTIVE value, read from the compositor. An option that cannot be
     *  read keeps the value this object already has: Hyprland's file is rewritten whole
     *  from this state, so a wrong read would be persisted, not just shown. */
    private async sync(): Promise<void> {
        this.state = await settings.readInput(this.state)
        this.emit("changed")
    }

    /** A patch rather than one option because some settings ARE two: a keyboard layout
     *  and its variant land together, in one apply, one write and one `changed`. */
    private async applyAndSave(patch: Partial<InputSettings>) {
        if (this._initPromise) {
            await this._initPromise
        }
        const changed = (Object.keys(patch) as InputKey[]).filter(k => patch[k] !== undefined)
        this.state = { ...this.state, ...patch }
        settings.setInput(this.state, changed)
        this.emit("changed")
    }

    setPointerSpeed(val: number) {
        return this.applyAndSave({ pointerSpeed: val })
    }

    setAccelProfile(val: string) {
        return this.applyAndSave({ accelProfile: val })
    }

    setMouseNaturalScroll(val: boolean) {
        return this.applyAndSave({ mouseNaturalScroll: val })
    }

    setTouchpadNaturalScroll(val: boolean) {
        return this.applyAndSave({ touchpadNaturalScroll: val })
    }

    setTouchpadTap(val: boolean) {
        return this.applyAndSave({ touchpadTap: val })
    }

    setNumlockOnBoot(val: boolean) {
        return this.applyAndSave({ numlockOnBoot: val })
    }

    setKbRepeatDelay(val: number) {
        return this.applyAndSave({ kbRepeatDelay: Math.round(val) })
    }

    setKbRepeatRate(val: number) {
        return this.applyAndSave({ kbRepeatRate: Math.round(val) })
    }

    /** Layout and variant are ONE change: a variant is meaningless against the
     *  wrong layout, so they apply and persist together. */
    setKbLayout(layout: string, variant = "") {
        return this.applyAndSave({ kbLayout: layout, kbVariant: variant })
    }
}

const inputConfig = new InputConfig()
export default inputConfig
