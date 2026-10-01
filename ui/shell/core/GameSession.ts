// GameSession — game mode around a game, on both compositors (#682).
//
// The compositor puts a game on its own workspace, `gamespace` (Hyalo: `[rules.games]`,
// hyalo/compositor/src/wm/games.rs; Hyprland: config/hypr/hyprland.lua). This module watches
// that workspace through CompositorState and does the rest from Settings → Gaming: the
// game's artwork (or an image) as the wallpaper, the performance power profile, holding
// notifications back, and the way back when the last game closes. The decisions are in
// `game-session-logic.ts`, where the CI probe can reach them; this file is the world they
// act on.
//
// ⚠️ SHELL ONLY — started from app.ts. A Settings process (#571) imports GamingManager and
// must not also run a game session. What `NotificationPopups` reads (`gameSilencing`) is
// false until `startGameSession` has run.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "../../lib/process"
import { writeFile } from "../../lib/nidara-kit/platform/file"
import compositor from "./CompositorState"
import Gaming from "./GamingManager"
import Wallpaper from "./WallpaperManager"
import {
    GAME_WORKSPACE, GameSessionLogic, type GameWindow, type GameWorld, type SessionRecord,
} from "./game-session-logic"

/** Where a running session is recorded, for a shell that restarts in the middle of one.
 *  The runtime dir: a session never outlives the login. */
const RECORD = GLib.build_filenamev([GLib.get_user_runtime_dir(), "nidara-game-session.json"])

// ── Steam: which game a window is, and its artwork ──────────────────────────

const STEAM_KEYS = new Set(["SteamAppId", "SteamGameId", "STEAM_APP_ID"])

/** The Steam app id in a process's environment, or in one of its parents' — Steam starts
 *  a game through a reaper and a launcher or two. The same walk as Hyalo's games.rs. */
function steamAppOfPid(pid: number): string | null {
    let p = pid
    for (let i = 0; i < 8 && p > 1; i++) {
        try {
            const [ok, env] = GLib.file_get_contents(`/proc/${p}/environ`)
            if (ok) {
                for (const entry of new TextDecoder().decode(env as Uint8Array).split("\0")) {
                    const eq = entry.indexOf("=")
                    if (eq > 0 && STEAM_KEYS.has(entry.slice(0, eq)) && /^[1-9]\d*$/.test(entry.slice(eq + 1)))
                        return entry.slice(eq + 1)
                }
            }
            const [sok, stat] = GLib.file_get_contents(`/proc/${p}/stat`)
            if (!sok) return null
            const text = new TextDecoder().decode(stat as Uint8Array)
            // The command name is in parentheses and may hold spaces: count from the last `)`.
            p = parseInt(text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/)[1] ?? "", 10)
            if (!Number.isFinite(p)) return null
        } catch {
            return null
        }
    }
    return null
}

/** Read once per window: the shell asks on every change of anything. */
const appIds = new Map<string, string | null>()

function appIdOf(address: string, cls: string, pid: number): string | null {
    if (appIds.has(address)) return appIds.get(address)!
    const m = cls.match(/^steam_app_(\d+)$/)
    const id = m ? m[1] : pid > 0 ? steamAppOfPid(pid) : null
    appIds.set(address, id)
    return id
}

/** Steam's library hero image for a game: directly in its folder, or (newer clients) one
 *  level down; never the blurred copy beside it. */
function steamArtwork(appId: string): string | null {
    const base = GLib.build_filenamev([GLib.get_home_dir(), ".steam", "steam", "appcache", "librarycache", appId])
    const flat = GLib.build_filenamev([base, "library_hero.jpg"])
    if (GLib.file_test(flat, GLib.FileTest.EXISTS)) return flat
    try {
        const en = Gio.File.new_for_path(base).enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
        let info: any
        while ((info = en.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY || info.get_name().includes("blur")) continue
            const p = GLib.build_filenamev([base, info.get_name(), "library_hero.jpg"])
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) { en.close(null); return p }
        }
        en.close(null)
    } catch { /* no folder for this game */ }
    return null
}

// ── The world the logic acts on ─────────────────────────────────────────────

function readRecord(): SessionRecord | null {
    try {
        const [ok, data] = GLib.file_get_contents(RECORD)
        if (!ok) return null
        const r = JSON.parse(new TextDecoder().decode(data as Uint8Array))
        return { prevProfile: r.prevProfile ?? null, wallpaperOutput: r.wallpaperOutput ?? null }
    } catch {
        return null
    }
}

const world: GameWorld = {
    choices: () => ({
        wallpaperMode: Gaming.wallpaperMode,
        customWallpaper: Gaming.customWallpaper,
        performanceProfile: Gaming.performanceProfile,
        silenceNotifications: Gaming.silenceNotifications,
    }),
    readProfile: () => execAsync(["powerprofilesctl", "get"]).then(s => s.trim(), () => ""),
    setProfile: p => execAsync(["powerprofilesctl", "set", p]).then(() => {}, e => console.error("[GameSession] powerprofilesctl:", e)),
    artworkFor: steamArtwork,
    fileExists: p => GLib.file_test(p, GLib.FileTest.EXISTS),
    showWallpaper: (path, output) => Wallpaper.showForGame(path, output),
    restoreWallpaper: output => Wallpaper.restoreAfterGame(output),
    focusedWorkspace: () => {
        const m = compositor.focusedMonitor
        return m ? { id: m.activeWorkspace.id, name: m.activeWorkspace.name } : null
    },
    focusWorkspace: id => compositor.focusWorkspace(id),
    save: r => {
        try {
            if (r) writeFile(RECORD, JSON.stringify(r))
            else if (GLib.file_test(RECORD, GLib.FileTest.EXISTS)) Gio.File.new_for_path(RECORD).delete(null)
        } catch (e) { console.error("[GameSession] record:", e) }
    },
    later: (ms, fn) => {
        let id: number | null = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { id = null; fn(); return GLib.SOURCE_REMOVE })
        return () => { if (id !== null) { GLib.source_remove(id); id = null } }
    },
}

let session: GameSessionLogic | null = null

function gameWindows(): GameWindow[] {
    const games = compositor.clients.filter(c => c.workspace.name === GAME_WORKSPACE)
    const live = new Set(compositor.clients.map(c => c.address))
    for (const a of appIds.keys()) if (!live.has(a)) appIds.delete(a)
    return games.map(c => ({
        address: c.address,
        appId: appIdOf(c.address, c.class, c.pid),
        output: compositor.monitors[c.monitor]?.name ?? compositor.focusedMonitor?.name ?? "",
    }))
}

/** Idempotent: a second call does nothing. */
export function startGameSession(): void {
    if (session) return
    session = new GameSessionLogic(world, readRecord())
    compositor.connect("changed", () => session!.update(gameWindows()))
    session.update(gameWindows())
}

/** Notifications wait: a game is running and Settings → Gaming asks for it. Asked when a
 *  notification arrives, so a change of the setting mid-game applies to the next one. */
export function gameSilencing(): boolean {
    return session?.silencing() ?? false
}
