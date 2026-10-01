import GObject from "gi://GObject"
import { defineSettings } from "./configFile"
import compositor, { settings } from "./CompositorState"

export type WorkspaceMode = "floating" | "tiling"

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ["floating", "tiling"]

export type WorkspaceOverrideMode = "default" | "floating" | "tiling"

export const WORKSPACE_OVERRIDE_MODES: readonly WorkspaceOverrideMode[] = ["default", "floating", "tiling"]

const isMode = (v: any): v is WorkspaceMode => v === "floating" || v === "tiling"

export interface WorkspacesSettings {
    defaultMode: WorkspaceMode
    workspaces: Record<string, WorkspaceMode>
}

const DEFAULTS: WorkspacesSettings = {
    defaultMode: "floating",
    workspaces: {},
}

const config = defineSettings<WorkspacesSettings>("workspaces", DEFAULTS, {
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

        // A config reload drops what was applied live: re-apply, writing nothing (a write
        // there could trigger the reload that called it).
        compositor.connect("config-reloaded", () => {
            this.pushAll()
        })

        // On boot: persist the table in the compositor's layer and apply it.
        this.save()
        this.pushAll()
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

    /** Returns the setting value for workspace wsId: explicit override if set, else "default". */
    getWorkspaceModeSetting(wsId: number): WorkspaceOverrideMode {
        return this.getExplicitMode(wsId) ?? "default"
    }

    /** Set the global default workspace mode */
    async setDefaultMode(mode: WorkspaceMode): Promise<void> {
        if (!isMode(mode)) throw new Error(`Invalid workspace mode: ${mode}`)
        if (this.defaultMode === mode) return

        config.set("defaultMode", mode)
        this.save()
        await this.pushAll()

        // Reorganize windows on workspaces inheriting defaultMode
        for (const wsId of [1, 2, 3, 4, 5]) {
            if (!this.getExplicitMode(wsId)) {
                if (mode === "tiling") {
                    await compositor.tileAllInWorkspace(wsId)
                } else {
                    await compositor.floatAllInWorkspace(wsId)
                }
            }
        }

        this.emit("changed")
    }

    /** Set mode for a specific workspace 1..5, or 'default' to inherit defaultMode. Reorganizes existing windows! */
    async setWorkspaceMode(wsId: number, mode: WorkspaceMode | "default"): Promise<void> {
        if (mode !== "default" && !isMode(mode)) throw new Error(`Invalid workspace mode: ${mode}`)
        if (wsId < 1 || wsId > 5) throw new Error(`Workspace id must be between 1 and 5 (got ${wsId})`)

        const currentModes = { ...config.get("workspaces") }
        if (mode === "default") {
            delete currentModes[String(wsId)]
            config.set("workspaces", currentModes)
            this.save()
            await this.pushAll()
        } else {
            currentModes[String(wsId)] = mode
            config.set("workspaces", currentModes)
            this.save()
            await this.pushAll()
        }

        // Reorganize existing windows on workspace wsId according to effective mode
        const effective = this.getEffectiveMode(wsId)
        if (effective === "tiling") {
            await compositor.tileAllInWorkspace(wsId)
        } else {
            await compositor.floatAllInWorkspace(wsId)
        }

        this.emit("changed")
    }

    /** Toggle mode for workspace wsId (or focused workspace if omitted). Reorganizes existing windows! */
    async toggleWorkspaceMode(wsId?: number): Promise<WorkspaceMode> {
        const id = wsId ?? compositor.focusedWorkspaceId
        if (id < 1 || id > 5) {
            throw new Error(`Cannot toggle workspace mode on special or invalid workspace ${id}`)
        }
        const current = this.getEffectiveMode(id)
        const next: WorkspaceMode = current === "floating" ? "tiling" : "floating"
        await this.setWorkspaceMode(id, next)
        return next
    }

    /** The table, persisted where the compositor reads it at login (`settings`). */
    private save(): void {
        settings.saveWorkspaceModes(this.defaultMode, config.get("workspaces"))
    }

    /** The whole table to the running compositor (Hyprland's `NIDARA_WS_MODES`, Hyalo's
     *  per-workspace modes). */
    pushAll(): Promise<unknown> {
        return compositor.applyWorkspaceModes(this.defaultMode, config.get("workspaces"))
    }

    subscribe = config.subscribe
}

export const workspaceModes = new WorkspaceModeManager()
export default workspaceModes
