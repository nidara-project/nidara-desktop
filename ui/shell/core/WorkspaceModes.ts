import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { writeFile } from "../../lib/file"
import { defineConfig } from "./configFile"
import hs from "./HyprlandState"
import { luaWorkspaceModesBlock } from "./hyprland-lua"

export type WorkspaceMode = "floating" | "tiling"

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ["floating", "tiling"]

const isMode = (v: any): v is WorkspaceMode => v === "floating" || v === "tiling"

export interface WorkspacesSettings {
    defaultMode: WorkspaceMode
    workspaces: Record<string, WorkspaceMode>
}

const DEFAULTS: WorkspacesSettings = {
    defaultMode: "floating",
    workspaces: {},
}

const config = defineConfig<WorkspacesSettings>("workspaces.json", DEFAULTS, {
    defaultMode: isMode,
    workspaces: v => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return false
        return Object.entries(v).every(
            ([k, val]) => /^\d+$/.test(k) && isMode(val)
        )
    },
})

class WorkspaceModeManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WorkspaceModeManager",
            Signals: {
                "changed": {},
            },
        }, this)
    }

    constructor() {
        super()
        config.subscribeAll(() => this.emit("changed"))

        // When Hyprland reloads its config externally, re-push the live table
        hs.connect("config-reloaded", () => {
            this.pushAllToHyprland()
        })

        // On boot: write nidara-workspaces.lua and push the full table to Hyprland
        this._saveLua()
        this.pushAllToHyprland()
    }

    get defaultMode(): WorkspaceMode {
        return config.get("defaultMode")
    }

    /** Map of explicit overrides (1..5) */
    get workspaces(): Readonly<Record<string, WorkspaceMode>> {
        return config.get("workspaces")
    }

    /** Effective mode for workspace wsId: returns explicit override if set, else defaultMode. */
    getEffectiveMode(wsId: number): WorkspaceMode {
        return config.get("workspaces")[String(wsId)] ?? this.defaultMode
    }

    /** Returns explicit override if defined, else undefined */
    getExplicitMode(wsId: number): WorkspaceMode | undefined {
        return config.get("workspaces")[String(wsId)]
    }

    /** Set the global default workspace mode */
    async setDefaultMode(mode: WorkspaceMode): Promise<void> {
        if (!isMode(mode)) throw new Error(`Invalid workspace mode: ${mode}`)
        if (this.defaultMode === mode) return

        config.set("defaultMode", mode)
        this._saveLua()
        await hs.evalLua(`if NIDARA_WS_MODES then NIDARA_WS_MODES.default = '${mode}' else NIDARA_WS_MODES = { default = '${mode}' } end`)
        this.emit("changed")
    }

    /** Set mode for a specific workspace 1..5. Reorganizes existing windows! */
    async setWorkspaceMode(wsId: number, mode: WorkspaceMode): Promise<void> {
        if (!isMode(mode)) throw new Error(`Invalid workspace mode: ${mode}`)
        if (wsId < 1 || wsId > 5) throw new Error(`Workspace id must be between 1 and 5 (got ${wsId})`)

        const currentModes = config.get("workspaces")
        config.set("workspaces", { ...currentModes, [String(wsId)]: mode })
        this._saveLua()
        await hs.evalLua(`if NIDARA_WS_MODES then NIDARA_WS_MODES[${wsId}] = '${mode}' else NIDARA_WS_MODES = { [${wsId}] = '${mode}' } end`)

        // Reorganize existing windows on workspace wsId
        if (mode === "tiling") {
            await hs.tileAllInWorkspace(wsId)
        } else {
            await hs.floatAllInWorkspace(wsId)
        }

        this.emit("changed")
    }

    /** Toggle mode for workspace wsId (or focused workspace if omitted). Reorganizes existing windows! */
    async toggleWorkspaceMode(wsId?: number): Promise<WorkspaceMode> {
        const id = wsId ?? hs.focusedWorkspaceId
        if (id < 1 || id > 5) {
            throw new Error(`Cannot toggle workspace mode on special or invalid workspace ${id}`)
        }
        const current = this.getEffectiveMode(id)
        const next: WorkspaceMode = current === "floating" ? "tiling" : "floating"
        await this.setWorkspaceMode(id, next)
        return next
    }

    private _saveLua(): void {
        const content = luaWorkspaceModesBlock(this.defaultMode, config.get("workspaces"))
        const configPath = GLib.build_filenamev([
            GLib.get_home_dir(), ".config", "nidara", "nidara-workspaces.lua"
        ])
        try {
            writeFile(configPath, content)
        } catch (e) {
            console.error("[WorkspaceModes] Failed to write nidara-workspaces.lua:", e)
        }
    }

    /** Push full table to Hyprland runtime */
    pushAllToHyprland(): void {
        const def = this.defaultMode
        const overrides = config.get("workspaces")
        const entries: string[] = [`default = '${def}'`]
        for (const [k, v] of Object.entries(overrides)) {
            const num = Number(k)
            if (Number.isInteger(num) && num > 0) {
                entries.push(`[${num}] = '${v}'`)
            }
        }
        const lua = `NIDARA_WS_MODES = { ${entries.join(", ")} }`
        hs.evalLua(lua)
    }

    subscribe = config.subscribe
}

export const workspaceModes = new WorkspaceModeManager()
export default workspaceModes
