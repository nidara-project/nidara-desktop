// Game-mode preferences: what the wallpaper does while a game runs, and whether
// the power profile follows.
//
// Stored in GSettings, `org.nidara.gaming` (#573). The compositor needs the same
// four values when a game window opens, and Lua inside Hyprland cannot read dconf
// — so the SHELL hands them over: `core/GamingSync.ts` writes
// ~/.config/nidara/nidara-gaming.lua (required at login) and pushes the table
// live. `readGamingCfg()` in hyprland.lua reads NIDARA_GAMING and nothing else.

import { defineSettings } from "./configFile"
import { TRANSITIONS, type TransitionType } from "./WallpaperManager"

export type WallpaperMode = "artwork" | "custom" | "none"

/** The valid values, declared where the setting lives. `config-entries.ts` used
 *  to spell this list out a second time for the agent-facing enum. */
export const WALLPAPER_MODES: readonly WallpaperMode[] = ["artwork", "custom", "none"]

interface GamingSettings {
    wallpaperMode: WallpaperMode
    customWallpaper: string
    transition: TransitionType
    performanceProfile: boolean
}

const DEFAULTS: GamingSettings = {
    wallpaperMode: "artwork",
    customWallpaper: "",
    transition: "grow",
    performanceProfile: false,
}

const config = defineSettings<GamingSettings>("gaming", DEFAULTS, {
    // Both are enums, and both reach a lookup table: a bogus `transition` is
    // handed to the wallpaper animator and a bogus `wallpaperMode` decides a
    // branch. The schema's choices refuse both from `gsettings set`; these catch
    // anything that reaches the store another way.
    wallpaperMode: v => WALLPAPER_MODES.includes(v),
    transition: v => TRANSITIONS.includes(v),
})

export const Gaming = {
    get wallpaperMode()      { return config.get("wallpaperMode") },
    get customWallpaper()    { return config.get("customWallpaper") },
    get transition()         { return config.get("transition") },
    get performanceProfile() { return config.get("performanceProfile") },

    setWallpaperMode(mode: WallpaperMode)   { config.set("wallpaperMode", mode) },
    setCustomWallpaper(path: string)        { config.set("customWallpaper", path) },
    setTransition(t: TransitionType)        { config.set("transition", t) },
    setPerformanceProfile(enabled: boolean) { config.set("performanceProfile", enabled) },

    /** Per-key change notification, with a disposer. Replaces the `changed`
     *  GObject signal this module used to carry, whose only subscriber re-read
     *  every field whichever one had moved. */
    subscribe: config.subscribe,
}

export default Gaming
