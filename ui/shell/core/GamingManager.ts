// Game-mode preferences: what the wallpaper does while a game runs, whether the power
// profile follows, and whether notifications wait.
//
// Stored in GSettings, `org.nidara.gaming` (#573). The shell is the one that acts on them,
// on both compositors (`core/GameSession.ts`); the compositor only puts the game on its own
// workspace.

import { defineSettings } from "./configFile"
import type { WallpaperMode } from "./game-session-logic"

export type { WallpaperMode }

/** The valid values, declared where the setting lives. `config-entries.ts` used
 *  to spell this list out a second time for the agent-facing enum. */
export const WALLPAPER_MODES: readonly WallpaperMode[] = ["artwork", "custom", "none"]

interface GamingSettings {
    wallpaperMode: WallpaperMode
    customWallpaper: string
    performanceProfile: boolean
    silenceNotifications: boolean
}

const DEFAULTS: GamingSettings = {
    wallpaperMode: "artwork",
    customWallpaper: "",
    performanceProfile: false,
    silenceNotifications: true,
}

const config = defineSettings<GamingSettings>("gaming", DEFAULTS, {
    // An enum that decides a branch. The schema's choices refuse a bogus value from
    // `gsettings set`; this catches anything that reaches the store another way.
    wallpaperMode: v => WALLPAPER_MODES.includes(v),
})

export const Gaming = {
    get wallpaperMode()        { return config.get("wallpaperMode") },
    get customWallpaper()      { return config.get("customWallpaper") },
    get performanceProfile()   { return config.get("performanceProfile") },
    get silenceNotifications() { return config.get("silenceNotifications") },

    setWallpaperMode(mode: WallpaperMode)     { config.set("wallpaperMode", mode) },
    setCustomWallpaper(path: string)          { config.set("customWallpaper", path) },
    setPerformanceProfile(enabled: boolean)   { config.set("performanceProfile", enabled) },
    setSilenceNotifications(enabled: boolean) { config.set("silenceNotifications", enabled) },

    /** Per-key change notification, with a disposer. Replaces the `changed`
     *  GObject signal this module used to carry, whose only subscriber re-read
     *  every field whichever one had moved. */
    subscribe: config.subscribe,
}

export default Gaming
