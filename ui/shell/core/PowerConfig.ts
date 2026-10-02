import { settings } from "./CompositorState"
import type { IdleConfig } from "./compositor-types"

// Settings → Power's idle steps, from whichever compositor runs: hypridle's file on Hyprland
// (`hyprland-settings.ts`), Hyalo's own `[idle]` on Hyalo (`hyalo/compositor/src/idle.rs`).

export type { IdleConfig }

const _listeners = new Set<(cfg: IdleConfig) => void>()

export function onIdleChanged(fn: (cfg: IdleConfig) => void): () => void {
    _listeners.add(fn)
    return () => _listeners.delete(fn)
}

export function getIdleConfig(): IdleConfig {
    return settings.readIdle()
}

export function updateIdleConfig(partial: Partial<IdleConfig>) {
    const updated = { ...settings.readIdle(), ...partial }
    settings.setIdle(updated)
    _listeners.forEach(fn => fn(updated))
}
