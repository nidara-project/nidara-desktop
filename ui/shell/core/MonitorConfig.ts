import { isSettingsProcess, settingsShellRequest } from "./SettingsProcess"
import GObject from "gi://GObject"
import compositor, { settings, type MonitorSetting } from "./CompositorState"

/**
 * The Display page's state: per monitor scale, rotation and mode, and the VRR choice — on
 * either compositor, through `settings` (CompositorState.ts). A change is applied live and
 * persisted in the compositor's own layer (`nidara-monitor.lua` on Hyprland,
 * `hyalo-settings.toml` on Hyalo); a mode or a rotation is applied WITHOUT persisting until
 * the user confirms it (`commit`), so a mode the monitor cannot show is reverted before it
 * reaches the file.
 *
 * VRR is read SYNCHRONOUSLY: `init()` is called with the monitor list and callers read
 * `.vrr` immediately after, so an async read would report "off" for a frame and the
 * Settings row would render the wrong state.
 */
class MonitorConfig extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: "MonitorConfigManager" }, this)
    }

    private state: Map<string, MonitorSetting> = new Map()
    private _vrr = 0
    private previews = new Map<string, string>()

    constructor() {
        super()
        // Re-read the effective VRR when the compositor reloads its config (the user edited
        // their own file). Otherwise the next save would persist our stale value over it.
        compositor.connect("config-reloaded", () => { this._vrr = settings.readVrr(this._vrr) })
    }

    /** Call once with the monitor list (core/Displays.ts). */
    init(monitors: Array<{ name: string; scale?: number; transform?: number; vrr?: number }>) {
        this.state.clear()
        for (const mon of monitors) {
            this.state.set(mon.name, {
                scale: Math.round((mon.scale ?? 1.0) * 100) / 100,
                transform: mon.transform ?? 0,
            })
        }
        // The compositor's own value, not a monitor's flag: on Hyprland VRR is one global
        // (0 off, 1 always, 2 fullscreen only); on Hyalo it is per output, and "on" when any is.
        this._vrr = settings.readVrr(this._vrr)
    }

    getScale(name: string) { return this.state.get(name)?.scale ?? 1.0 }
    getTransform(name: string) { return this.state.get(name)?.transform ?? 0 }
    getMode(name: string) { return this.state.get(name)?.mode }
    get vrr() { return this._vrr }

    private _apply(name: string, cfg: MonitorSetting) {
        settings.applyMonitor(name, cfg)
    }

    async setScale(name: string, scale: number) {
        if (isSettingsProcess) {
            await settingsShellRequest(["settingsMonitor", "scale", name, String(scale)])
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.scale = scale; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.scale = scale
        this.state.set(name, cfg)
        this._apply(name, cfg)
        this._save()
    }

    setTransform(name: string, transform: number) {
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.transform = transform
        this.state.set(name, cfg)
        this._apply(name, cfg)
        this._save()
    }

    /** Apply a resolution/refresh mode WITHOUT persisting — pair with commit() once
     *  the user confirms (so a bad mode can be reverted before it reaches the file). */
    async applyMode(name: string, mode: string) {
        if (isSettingsProcess) {
            const token = await settingsShellRequest(["settingsMonitor", "mode", name, mode])
            this.previews.set(name, token)
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.mode = mode; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.mode = mode
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Apply a rotation WITHOUT persisting — pair with commit() (revert-safe). */
    async applyTransform(name: string, transform: number) {
        if (isSettingsProcess) {
            const token = await settingsShellRequest(["settingsMonitor", "transform", name, String(transform)])
            this.previews.set(name, token)
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.transform = transform; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.transform = transform
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Persist what is applied now (the confirm half of applyMode/applyTransform). */
    async commit(output?: string) {
        if (!isSettingsProcess) { this._save(); return }
        if (!output) throw Error("Confirm one display preview at a time")
        const token = this.previews.get(output)
        if (!token) throw Error("Display preview is no longer pending")
        await settingsShellRequest(["settingsMonitor", "commit", token])
        this.previews.delete(output)
    }

    async revert(name: string) {
        const token = this.previews.get(name)
        if (!token) return
        try { await settingsShellRequest(["settingsMonitor", "revert", token]) }
        catch (e) { if (!String(e).includes("expired")) throw e }
        finally { this.previews.delete(name) }
    }

    async setVrr(val: number) {
        if (isSettingsProcess) {
            await settingsShellRequest(["settingsMonitor", "vrr", "all", String(val)])
            this._vrr = val; return
        }
        this._vrr = val
        settings.applyVrr(val)
        this._save()
    }

    private _save() {
        settings.saveMonitors(this.state, this._vrr)
    }
}

const monitorConfig = new MonitorConfig()
export default monitorConfig
