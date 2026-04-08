import GObject from "gi://GObject"

/**
 * Crystal Shell UI Status Engine
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
                "settings-open": GObject.ParamSpec.boolean("settings-open", "Settings Open", "Settings window visibility", GObject.ParamFlags.READWRITE, false),
                "cc-edit-mode": GObject.ParamSpec.boolean("cc-edit-mode", "CC Edit Mode", "CC edit mode active", GObject.ParamFlags.READWRITE, false),
                "system-menu-open": GObject.ParamSpec.boolean("system-menu-open", "System Menu Open", "System Menu visibility", GObject.ParamFlags.READWRITE, false),
                "overview-open": GObject.ParamSpec.boolean("overview-open", "Overview Open", "Overview visibility", GObject.ParamFlags.READWRITE, false),
                "power-menu-open": GObject.ParamSpec.boolean("power-menu-open", "Power Menu Open", "Power Menu visibility", GObject.ParamFlags.READWRITE, false),
                "about-open": GObject.ParamSpec.boolean("about-open", "About Open", "About window visibility", GObject.ParamFlags.READWRITE, false),
            },
            Signals: {
                "toggle-cc": {},
                "toggle-nc": {},
                "toggle-prism": {},
                "toggle-system-menu": {},
                "toggle-overview": {},
                "toggle-power-menu": {},
            }
        }, this)
    }

    private _cc_open = false
    private _nc_open = false
    private _prism_open = false
    private _notif_active = false
    private _settings_open = false
    private _cc_edit_mode  = false
    private _system_menu_open = false
    private _overview_open = false
    private _power_menu_open = false
    private _about_open = false

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
            this._system_menu_open = false
            this._overview_open = false
            this._power_menu_open = false
            this.notify("nc-open")
            this.notify("prism-open")
            this.notify("notif-active")
            this.notify("system-menu-open")
            this.notify("overview-open")
            this.notify("power-menu-open")
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
            this._system_menu_open = false
            this._overview_open = false
            this._power_menu_open = false
            this.notify("cc-open")
            this.notify("prism-open")
            this.notify("notif-active")
            this.notify("system-menu-open")
            this.notify("overview-open")
            this.notify("power-menu-open")
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
            this._system_menu_open = false
            this._overview_open = false
            this._power_menu_open = false
            this.notify("cc-open")
            this.notify("nc-open")
            this.notify("system-menu-open")
            this.notify("overview-open")
            this.notify("power-menu-open")
        }
        this.notify("prism-open")
    }

    public get settings_open() { return this._settings_open }
    public set settings_open(v: boolean) {
        if (this._settings_open === v) return
        this._settings_open = v
        this.notify("settings-open")
    }

    public get cc_edit_mode() { return this._cc_edit_mode }
    public set cc_edit_mode(v: boolean) {
        if (this._cc_edit_mode === v) return
        this._cc_edit_mode = v
        this.notify("cc-edit-mode")
    }

    public get system_menu_open() { return this._system_menu_open }
    public set system_menu_open(v: boolean) {
        if (this._system_menu_open === v) return
        this._system_menu_open = v
        if (v) {
            this._cc_open = false
            this._nc_open = false
            this._prism_open = false
            this._overview_open = false
            this._power_menu_open = false
            this.notify("cc-open")
            this.notify("nc-open")
            this.notify("prism-open")
            this.notify("overview-open")
            this.notify("power-menu-open")
        }
        this.notify("system-menu-open")
    }

    public get overview_open() { return this._overview_open }
    public set overview_open(v: boolean) {
        if (this._overview_open === v) return
        this._overview_open = v
        if (v) {
            this._cc_open = false
            this._nc_open = false
            this._prism_open = false
            this._system_menu_open = false
            this._power_menu_open = false
            this.notify("cc-open")
            this.notify("nc-open")
            this.notify("prism-open")
            this.notify("system-menu-open")
            this.notify("power-menu-open")
        }
        this.notify("overview-open")
    }

    public get isAnyOverlayOpen(): boolean {
        return this._cc_open || this._nc_open || this._prism_open || this._system_menu_open || this._overview_open || this._power_menu_open
    }

    public get power_menu_open() { return this._power_menu_open }
    public set power_menu_open(v: boolean) {
        if (this._power_menu_open === v) return
        this._power_menu_open = v
        if (v) {
            this._cc_open = false
            this._nc_open = false
            this._prism_open = false
            this._system_menu_open = false
            this._overview_open = false
            this.notify("cc-open")
            this.notify("nc-open")
            this.notify("prism-open")
            this.notify("system-menu-open")
            this.notify("overview-open")
        }
        this.notify("power-menu-open")
    }

    public get about_open() { return this._about_open }
    public set about_open(v: boolean) {
        if (this._about_open === v) return
        this._about_open = v
        if (v) this._system_menu_open = false
        this.notify("about-open")
        if (v) this.notify("system-menu-open")
    }

    toggleCC() { this.cc_open = !this.cc_open }
    toggleNC() { this.nc_open = !this.nc_open }
    togglePrism() { this.prism_open = !this.prism_open }
    toggleSystemMenu() { this.system_menu_open = !this.system_menu_open }
    toggleOverview() { this.overview_open = !this.overview_open }
    togglePowerMenu() { this.power_menu_open = !this.power_menu_open }
    toggleAbout() { this.about_open = !this.about_open }
}

export const status = new UIStatus()
export default status
