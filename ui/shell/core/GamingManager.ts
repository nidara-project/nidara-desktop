// Game-mode preferences: what the wallpaper does while a game runs, and whether
// the power profile follows.
//
// ⚠️ This file is read by TWO consumers with different parsers. The shell reads
// it through the store below; `config/hypr/hyprland.lua` reads the raw text with
// `raw:match('"wallpaperMode"%s*:%s*"([^"]+)"')` and three siblings, because Lua
// has no JSON parser and the compositor config must not gain a dependency for
// four fields. So the KEY NAMES and the string-valued shape of this file are a
// contract with `readGamingCfg()` in hyprland.lua — renaming a key here changes
// nothing that compiles and silently drops game mode to its defaults.

import { defineConfig } from "./configFile"
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

const config = defineConfig<GamingSettings>("gaming.json", DEFAULTS, {
    // Both are enums, and both reach a lookup table: a bogus `transition` is
    // handed to the wallpaper animator and a bogus `wallpaperMode` decides a
    // branch. `loadKnown`'s typeof check passes any string for either.
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
