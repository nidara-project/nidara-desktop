import GObject from "gi://GObject"

/**
 * 🛰️ CRYSTAL_SHELL UI STATUS ENGINE
 * 
 * Centralized GObject-based state for overlays.
 * Allows reactive binding without App-level signal collision.
 */
export class UIStatus extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "Crystal_ShellUIStatus",
            Properties: {
                "cc-open": GObject.ParamSpec.boolean("cc-open", "CC Open", "Control Center visibility", GObject.ParamFlags.READWRITE, false),
                "nc-open": GObject.ParamSpec.boolean("nc-open", "NC Open", "Notification Center visibility", GObject.ParamFlags.READWRITE, false),
                "prism-open": GObject.ParamSpec.boolean("prism-open", "Prism Open", "Prism Search visibility", GObject.ParamFlags.READWRITE, false),
                "notif-active": GObject.ParamSpec.boolean("notif-active", "Notif Active", "Popups visibility", GObject.ParamFlags.READWRITE, false),
            },
            Signals: {
                "toggle-cc": {},
                "toggle-nc": {},
                "toggle-prism": {},
            }
        }, this)
    }

    private _cc_open = false
    private _nc_open = false
    private _prism_open = false
    private _notif_active = false

    public get notif_active() { return this._notif_active }
    public set notif_active(v: boolean) {
        if (this._notif_active === v) return
        this._notif_active = v
        this.notify("notif-active")
    }

    public get cc_open() { return this._cc_open }
    public set cc_open(v: boolean) { 
        if (this._cc_open === v) return
        this._cc_open = v
        if (v) {
            this._nc_open = false
            this._prism_open = false
            this._notif_active = false
            this.notify("nc-open")
            this.notify("prism-open")
            this.notify("notif-active")
        }
        this.notify("cc-open")
    }

    public get nc_open() { return this._nc_open }
    public set nc_open(v: boolean) {
        if (this._nc_open === v) return
        this._nc_open = v
        if (v) {
            this._cc_open = false
            this._prism_open = false
            this._notif_active = false
            this.notify("cc-open")
            this.notify("prism-open")
            this.notify("notif-active")
        }
        this.notify("nc-open")
    }

    public get prism_open() { return this._prism_open }
    public set prism_open(v: boolean) {
        if (this._prism_open === v) return
        this._prism_open = v
        if (v) { 
            this._cc_open = false
            this._nc_open = false
            this.notify("cc-open")
            this.notify("nc-open")
        }
        this.notify("prism-open")
    }

    toggleCC() { this.cc_open = !this.cc_open }
    toggleNC() { this.nc_open = !this.nc_open }
    togglePrism() { this.prism_open = !this.prism_open }
}

export const status = new UIStatus()
export default status
