// Hands game mode's settings to the compositor (#573).
//
// `config/hypr/hyprland.lua` decides, when a game window opens, whether to swap the
// wallpaper and the power profile — and Lua inside Hyprland cannot read GSettings.
// It used to pattern-match gaming.json's raw text. Now the shell is the one process
// that tells it, twice over:
//   - ~/.config/nidara/nidara-gaming.lua, `safe_require`d at login, so a game
//     opened before the shell is up (or while it restarts) still gets the choice;
//   - the same `NIDARA_GAMING = { … }` pushed with `hyprctl eval` on every change
//     and after every config reload, so no reload is needed to apply one.
//
// ⚠️ SHELL ONLY. This is the side-effect half that must happen once for the
// desktop, which is why it is a separate module started from app.ts instead of
// living in GamingManager: a Settings process (#571) imports the store and must
// not also write the compositor's file.

import GLib from "gi://GLib"
import { writeFile } from "../../lib/file"
import Gaming from "./GamingManager"
import hs from "./HyprlandState"
import { luaGamingBlock } from "./hyprland-lua"

const LUA_PATH = GLib.build_filenamev([GLib.get_home_dir(), ".config", "nidara", "nidara-gaming.lua"])

let started = false

function block(): string {
    return luaGamingBlock({
        wallpaperMode: Gaming.wallpaperMode,
        customWallpaper: Gaming.customWallpaper,
        transition: Gaming.transition,
        performanceProfile: Gaming.performanceProfile,
    })
}

function sync(): void {
    const lua = block()
    try {
        writeFile(LUA_PATH, lua)
    } catch (e) {
        console.error("[GamingSync] Failed to write nidara-gaming.lua:", e)
    }
    hs.evalLua(lua)
}

/** Idempotent: a second call does nothing. */
export function startGamingSync(): void {
    if (started) return
    started = true
    for (const key of ["wallpaperMode", "customWallpaper", "transition", "performanceProfile"] as const) {
        Gaming.subscribe(key, sync)
    }
    hs.connect("config-reloaded", () => hs.evalLua(block()))
    sync()
}
