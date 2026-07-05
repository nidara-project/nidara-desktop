import GObject from "gi://GObject"

/**
 * Nidara UI Status Engine
 * 
 * Centralized GObject-based state for overlays.
 * Allows reactive binding without App-level signal collision.
 */
export class UIStatus extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "Nidara_ShellUIStatus",
            Properties: {
                "cc-open": GObject.ParamSpec.boolean("cc-open", "CC Open", "Control Center visibility", GObject.ParamFlags.READWRITE, false),
                "nc-open": GObject.ParamSpec.boolean("nc-open", "NC Open", "Notification Center visibility", GObject.ParamFlags.READWRITE, false),
                "prism-open": GObject.ParamSpec.boolean("prism-open", "Prism Open", "Prism Search visibility", GObject.ParamFlags.READWRITE, false),
                "notif-active": GObject.ParamSpec.boolean("notif-active", "Notif Active", "Popups visibility", GObject.ParamFlags.READWRITE, false),
                "settings-open": GObject.ParamSpec.boolean("settings-open", "Settings Open", "Settings window visibility", GObject.ParamFlags.READWRITE, false),
                "cc-edit-mode": GObject.ParamSpec.boolean("cc-edit-mode", "CC Edit Mode", "CC edit mode active", GObject.ParamFlags.READWRITE, false),
                "system-menu-open": GObject.ParamSpec.boolean("system-menu-open", "System Menu Open", "System Menu visibility", GObject.ParamFlags.READWRITE, false),
                "overview-open": GObject.ParamSpec.boolean("overview-open", "Overview Open", "Overview visibility", GObject.ParamFlags.READWRITE, false),
                "about-open": GObject.ParamSpec.boolean("about-open", "About Open", "About window visibility", GObject.ParamFlags.READWRITE, false),
                "recording": GObject.ParamSpec.boolean("recording", "Recording", "Screen recording active", GObject.ParamFlags.READWRITE, false),
                "bar-expanded-id": GObject.ParamSpec.string("bar-expanded-id", "Bar Expanded ID", "ID of the expanded bar widget, empty = none", GObject.ParamFlags.READWRITE, ""),
                "cc-detail-id": GObject.ParamSpec.string("cc-detail-id", "CC Detail ID", "Widget ID to open in CC detail view, empty = none", GObject.ParamFlags.READWRITE, ""),
            },
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
    private _about_open = false
    private _recording = false
    private _bar_expanded_id = ""
    private _cc_detail_id = ""

    // The five mutually-exclusive overlays. Opening one closes the rest.
    // Maps the snake-cased backing field to its GObject notify name.
    private static readonly EXCLUSIVE: Record<string, string> = {
        _cc_open: "cc-open",
        _nc_open: "nc-open",
        _prism_open: "prism-open",
        _system_menu_open: "system-menu-open",
        _overview_open: "overview-open",
    }

    /**
     * Close every mutually-exclusive overlay except `keep`, plus optionally clear
     * the popup/bar-expanded state. Only emits notify for fields that actually
     * changed. Single source of truth for the exclusion logic the setters share.
     */
    private closeExclusive(keep: string, opts: { notif?: boolean; barExpanded?: boolean } = {}) {
        const self = this as any
        for (const [field, name] of Object.entries(UIStatus.EXCLUSIVE)) {
            if (field === keep) continue
            if (self[field]) {
                self[field] = false
                this.notify(name)
            }
        }
        if (opts.notif && this._notif_active) {
            this._notif_active = false
            this.notify("notif-active")
        }
        if (opts.barExpanded && this._bar_expanded_id !== "") {
            this._bar_expanded_id = ""
            this.notify("bar-expanded-id")
        }
    }

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
        if (v) this.closeExclusive("_cc_open", { notif: true, barExpanded: true })
        this.notify("cc-open")
    }

    public get nc_open() { return this._nc_open }
    public set nc_open(v: boolean) {
        if (this._nc_open === v) return
        this._nc_open = v
        if (v) this.closeExclusive("_nc_open", { notif: true, barExpanded: true })
        this.notify("nc-open")
    }

    public get prism_open() { return this._prism_open }
    public set prism_open(v: boolean) {
        if (this._prism_open === v) return
        this._prism_open = v
        // Note: opening Prism does not dismiss active popups (preserves prior behavior).
        if (v) this.closeExclusive("_prism_open", { barExpanded: true })
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
        if (v) this.closeExclusive("_system_menu_open", { barExpanded: true })
        this.notify("system-menu-open")
    }

    public get overview_open() { return this._overview_open }
    public set overview_open(v: boolean) {
        if (this._overview_open === v) return
        this._overview_open = v
        if (v) this.closeExclusive("_overview_open", { barExpanded: true })
        this.notify("overview-open")
    }

    public get isAnyOverlayOpen(): boolean {
        return this._cc_open || this._nc_open || this._prism_open || this._system_menu_open || this._overview_open || this._bar_expanded_id !== ""
    }

    public get about_open() { return this._about_open }
    public set about_open(v: boolean) {
        if (this._about_open === v) return
        this._about_open = v
        if (v) this._system_menu_open = false
        this.notify("about-open")
        if (v) this.notify("system-menu-open")
    }

    public get recording() { return this._recording }
    public set recording(v: boolean) {
        if (this._recording === v) return
        this._recording = v
        this.notify("recording")
    }

    public get bar_expanded_id() { return this._bar_expanded_id }
    public set bar_expanded_id(v: string) {
        if (this._bar_expanded_id === v) return
        this._bar_expanded_id = v
        // A pill expansion is exclusive with the big overlays too — reachable
        // since the bar strip stays clickable while an overlay is open.
        if (v !== "") this.closeExclusive("")
        this.notify("bar-expanded-id")
    }

    public get cc_detail_id() { return this._cc_detail_id }
    public set cc_detail_id(v: string) {
        if (this._cc_detail_id === v) return
        this._cc_detail_id = v
        this.notify("cc-detail-id")
    }

    toggleCC() { this.cc_open = !this.cc_open }
    toggleNC() { this.nc_open = !this.nc_open }
    togglePrism() { this.prism_open = !this.prism_open }
    toggleSystemMenu() { this.system_menu_open = !this.system_menu_open }
    toggleOverview() { this.overview_open = !this.overview_open }
    toggleAbout() { this.about_open = !this.about_open }
}

export const status = new UIStatus()
export default status
