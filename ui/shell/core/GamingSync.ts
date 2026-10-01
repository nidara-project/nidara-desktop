// Hands game mode's settings to the compositor (#573).
//
// When a game window opens, the compositor's side of game mode decides whether to swap the
// wallpaper and the power profile — on Hyprland that is `config/hypr/hyprland.lua`, and Lua
// inside Hyprland cannot read GSettings. The shell is the one process that tells it, through
// `settings.setGamingPolicy` (CompositorState.ts): persisted where the compositor reads it at
// login, so a game opened before the shell is up (or while it restarts) still gets the
// choice, and applied live on every change and after every config reload. Hyalo has no game
// mode yet (`settings.caps.gameMode`, #682).
//
// ⚠️ SHELL ONLY. This is the side-effect half that must happen once for the desktop, which
// is why it is a separate module started from app.ts instead of living in GamingManager: a
// Settings process (#571) imports the store and must not also write the compositor's file.

import Gaming from "./GamingManager"
import compositor, { settings, type GamingPolicy } from "./CompositorState"

let started = false

function policy(): GamingPolicy {
    return {
        wallpaperMode: Gaming.wallpaperMode,
        customWallpaper: Gaming.customWallpaper,
        transition: Gaming.transition,
        performanceProfile: Gaming.performanceProfile,
    }
}

/** Idempotent: a second call does nothing. */
export function startGamingSync(): void {
    if (started) return
    started = true
    for (const key of ["wallpaperMode", "customWallpaper", "transition", "performanceProfile"] as const) {
        Gaming.subscribe(key, () => settings.setGamingPolicy(policy(), false))
    }
    compositor.connect("config-reloaded", () => settings.setGamingPolicy(policy(), true))
    settings.setGamingPolicy(policy(), false)
}
