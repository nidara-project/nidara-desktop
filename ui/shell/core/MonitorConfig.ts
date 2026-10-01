import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { writeFile } from "../../lib/nidara-kit/platform/file"
import compositor, { hyprlandOnly } from "./CompositorState"
import { compositorOption } from "./HyprlandState"
import { luaConfigExpr } from "./hyprland-lua"
import displays, { TRANSFORM_NAMES } from "./Displays"
import * as hyalo from "./hyalo-ipc"

/**
 * TWO compositors, one module (#681). On Hyprland a change is applied with `hl.monitor()`
 * through `eval` and persisted as `nidara-monitor.lua`; on Hyalo it is applied over IPC
 * (`set_output`) and persisted as `~/.config/nidara/hyalo-settings.toml`, the layer Hyalo
 * reads between its shipped defaults and the user's own `hyalo.toml` (which wins, as
 * `hyprland-user.lua` does). Which one is decided once, by `displays.onHyalo`.
 *
 * The one global option this module owns, named ONCE.
 *
 * ⚠️ Read SYNCHRONOUSLY here, unlike `InputConfig`, and that is deliberate:
 * `init()` is called with the monitor list and callers read `.vrr` immediately
 * after, so an async read would report "off" for a frame and the Settings row
 * would render the wrong state. The pairing still owns the NAME and the live
 * apply — the half that could drift — and the sync read borrows the name from
 * it rather than spelling `misc:vrr` a third time.
 */
const VRR = compositorOption("misc:vrr", "int")

interface MonitorState {
    scale: number
    transform: number
    /** Explicit mode "WxH@Hz"; undefined → "preferred". */
    mode?: string
}

class MonitorConfig extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: "MonitorConfigManager" }, this)
    }

    private state: Map<string, MonitorState> = new Map()
    private _vrr = 0

    constructor() {
        super()
        if (displays.onHyalo) return
        // Re-read the effective vrr if Hyprland reloads its config (e.g. the user
        // edits hyprland-user.lua). Otherwise the next _save() would persist our
        // stale _vrr back into nidara-monitor.lua, clobbering the external change.
        compositor.connect("config-reloaded", () => { this._vrr = hyprlandOnly()?.getOptionInt(VRR.name, this._vrr) ?? this._vrr })
    }

    /** Call once with the monitor list from AstalHyprland.get_monitors() */
    init(monitors: Array<{ name: string; scale?: number; transform?: number; vrr?: number }>) {
        this.state.clear()
        for (const mon of monitors) {
            this.state.set(mon.name, {
                scale: Math.round((mon.scale ?? 1.0) * 100) / 100,
                transform: mon.transform ?? 0,
            })
        }
        // Hyalo's VRR is per output and has no "fullscreen only" yet (it needs fullscreen
        // windows, #682): 1 when any output has it on.
        if (displays.onHyalo) {
            this._vrr = displays.monitors.some(m => m.vrrEnabled) ? 1 : 0
            return
        }
        // misc:vrr is a GLOBAL int (0=off, 1=always, 2=fullscreen-only). AstalHyprland's
        // Monitor.vrr is just a per-monitor bool and doesn't reflect it, so read the real
        // effective value via HyprlandState (otherwise it resets to off on UI reload).
        this._vrr = hyprlandOnly()?.getOptionInt(VRR.name, this._vrr) ?? this._vrr
    }

    getScale(name: string) { return this.state.get(name)?.scale ?? 1.0 }
    getTransform(name: string) { return this.state.get(name)?.transform ?? 0 }
    getMode(name: string) { return this.state.get(name)?.mode }
    get vrr() { return this._vrr }

    private _apply(name: string, cfg: MonitorState) {
        if (displays.onHyalo) {
            const err = hyalo.setOutput(name, {
                scale: cfg.scale,
                transform: TRANSFORM_NAMES[cfg.transform] ?? "normal",
                ...(cfg.mode ? { mode: cfg.mode } : {}),
            })
            if (err) console.error(`[MonitorConfig] Hyalo refused ${name}: ${err}`)
            return
        }
        // This config uses Hyprland's Lua parser, where `hyprctl keyword` is rejected
        // ("can't work with non-legacy parsers. Use eval."). Apply via eval
        // running the same hl.monitor() call the persisted .lua uses.
        const mode = cfg.mode ?? "preferred"
        hyprlandOnly()?.evalLua(`hl.monitor({ output = '${name}', mode = '${mode}', position = 'auto', scale = ${cfg.scale}, transform = ${cfg.transform} })`)
    }

    setScale(name: string, scale: number) {
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
     *  the user confirms (so a bad mode can be reverted without touching the .lua). */
    applyMode(name: string, mode: string) {
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.mode = mode
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Apply a rotation WITHOUT persisting — pair with commit() (revert-safe). */
    applyTransform(name: string, transform: number) {
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.transform = transform
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Persist the current in-memory state to nidara-monitor.lua. */
    commit() { this._save() }

    setVrr(val: number) {
        this._vrr = val
        if (displays.onHyalo) {
            // Per output, on those that have it; the rest would refuse.
            for (const m of displays.monitors.filter(m => m.vrrSupported)) {
                const err = hyalo.setOutput(m.name, { vrr: val === 1 })
                if (err) console.error(`[MonitorConfig] Hyalo refused VRR on ${m.name}: ${err}`)
            }
        } else {
            VRR.apply(val)
        }
        this._save()
    }

    /** Hyalo's half of `_save`: the TOML layer Settings owns. */
    private _saveHyalo() {
        const vrrOn = new Set(this._vrr === 1
            ? displays.monitors.filter(m => m.vrrSupported).map(m => m.name) : [])
        const lines: string[] = [
            "# Written by Nidara Settings (Display) — do not edit: it is rewritten on every change.",
            "# Your own settings go in hyalo.toml next to it, which is read after this file and wins.",
        ]
        for (const [name, cfg] of this.state.entries()) {
            lines.push("", `[outputs.${JSON.stringify(name)}]`)
            if (cfg.mode) lines.push(`mode = ${JSON.stringify(cfg.mode)}`)
            // Always a float in TOML (`1.0`, not `1`).
            lines.push(`scale = ${Number.isInteger(cfg.scale) ? cfg.scale.toFixed(1) : cfg.scale}`)
            lines.push(`transform = ${JSON.stringify(TRANSFORM_NAMES[cfg.transform] ?? "normal")}`)
            lines.push(`vrr = ${vrrOn.has(name)}`)
        }
        const path = GLib.build_filenamev([GLib.get_home_dir(), ".config", "nidara", "hyalo-settings.toml"])
        try {
            writeFile(path, lines.join("\n") + "\n")
        } catch (e) {
            console.error("[MonitorConfig] Failed to write hyalo-settings.toml:", e)
        }
    }

    private _save() {
        if (displays.onHyalo) return this._saveHyalo()
        const lines: string[] = [
            "-- NIDARA SHELL MONITOR SETTINGS",
            "-- Auto-generated by Nidara Settings UI. Do not edit manually.",
            "",
        ]

        for (const [name, cfg] of this.state.entries()) {
            const mode = cfg.mode ?? "preferred"
            if (cfg.transform !== 0) {
                lines.push(`hl.monitor({ output = "${name}", mode = "${mode}", position = "auto", scale = ${cfg.scale}, transform = ${cfg.transform} })`)
            } else {
                lines.push(`hl.monitor({ output = "${name}", mode = "${mode}", position = "auto", scale = ${cfg.scale} })`)
            }
        }

        if (this._vrr !== 0) {
            lines.push("")
            // The SAME expression `VRR.apply` sends live, from the same builder —
            // apply and persist are two halves of one change and must not be two
            // spellings of it.
            lines.push(luaConfigExpr(VRR.name, this._vrr))
        }

        const configPath = GLib.build_filenamev([
            GLib.get_home_dir(), ".config", "nidara", "nidara-monitor.lua"
        ])
        try {
            // `writeFile` rather than `GLib.file_set_contents`: both rename a
            // temporary into place, so neither can be caught half-written, but only
            // this one fsyncs — and it creates the directory. `hyprland.lua`
            // requires this file at every login.
            writeFile(configPath, lines.join("\n") + "\n")
        } catch (e) {
            console.error("[MonitorConfig] Failed to write config:", e)
        }
    }
}

const monitorConfig = new MonitorConfig()
export default monitorConfig
