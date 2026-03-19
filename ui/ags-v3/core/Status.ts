import GObject from "gi://GObject"

/**
 * 🛰️ DISTROIA UI STATUS ENGINE
 * 
 * Centralized GObject-based state for overlays.
 * Allows reactive binding without App-level signal collision.
 */
export class UIStatus extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "DistroiaUIStatus",
            Properties: {
                "cc-open": GObject.ParamSpec.boolean("cc-open", "CC Open", "Control Center visibility", GObject.ParamFlags.READWRITE, false),
                "nc-open": GObject.ParamSpec.boolean("nc-open", "NC Open", "Notification Center visibility", GObject.ParamFlags.READWRITE, false),
                "prism-open": GObject.ParamSpec.boolean("prism-open", "Prism Open", "Prism Search visibility", GObject.ParamFlags.READWRITE, false),
            },
            Signals: {
                "toggle-cc": {},
                "toggle-nc": {},
                "toggle-prism": {},
            }
        }, this)
    }

    private _ccOpen = false
    private _ncOpen = false
    private _prismOpen = false

    get cc_open() { return this._ccOpen }
    set cc_open(v: boolean) { 
        if (this._ccOpen === v) return
        this._ccOpen = v
        if (v) { this._ncOpen = false; this._prismOpen = false; this.notify("nc-open"); this.notify("prism-open") }
        this.notify("cc-open")
    }

    get nc_open() { return this._ncOpen }
    set nc_open(v: boolean) {
        if (this._ncOpen === v) return
        this._ncOpen = v
        if (v) { this._ccOpen = false; this._prismOpen = false; this.notify("cc-open"); this.notify("prism-open") }
        this.notify("nc-open")
    }

    get prism_open() { return this._prismOpen }
    set prism_open(v: boolean) {
        if (this._prismOpen === v) return
        this._prismOpen = v
        if (v) { this._ccOpen = false; this._ncOpen = false; this.notify("cc-open"); this.notify("nc-open") }
        this.notify("prism-open")
    }

    toggleCC() { this.cc_open = !this.cc_open }
    toggleNC() { this.nc_open = !this.nc_open }
    togglePrism() { this.prism_open = !this.prism_open }
}

export const status = new UIStatus()
export default status
