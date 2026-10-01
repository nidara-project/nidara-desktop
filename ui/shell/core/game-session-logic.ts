// game-session-logic.ts — what game mode does around a game, as decisions: no GTK, no
// compositor, no files. `core/GameSession.ts` hands it the world; the CI probe
// (`scripts/dev/game-session-probe.ts`) hands it a fake one.
//
// Who does what (#682, the owner's decision of 2026-10-01): the COMPOSITOR recognises a
// game and gives it a workspace of its own, `gamespace` — Hyalo with its `[rules.games]`
// (hyalo/compositor/src/wm/games.rs), Hyprland with `config/hypr/hyprland.lua`. Everything
// around the game is the shell's, here, once for both: the wallpaper, the power profile,
// holding notifications back, and taking the user back when the last game closes.
//
// 🔑 A session is something that has to be UNDONE, so entering CAPTURES what it changes and
// leaving puts back what it captured — never a constant. Each rule below was a bug once, in
// the Lua this replaces (architecture.md → "Game mode"):
//   - the profile to go back to is the one from before the game; a session started from
//     Power saver ends in Power saver, not in Balanced;
//   - and only if the profile is STILL the one we set: one the user picked mid-game is a
//     newer decision than ours;
//   - undoing the session and taking the user back are two jobs: the session is undone
//     wherever the user is; only the return depends on standing on `gamespace`;
//   - one session however many game windows (a launcher and the game): a second window
//     must not capture the profile the first one already changed.
//
// What a session changed is RECORDED (`save`) as it goes, so a shell that restarts in the
// middle of one adopts it instead of capturing "performance" as the profile to go back to.

/** The workspace both compositors put games on. */
export const GAME_WORKSPACE = "gamespace"

/** After the last game window closes, how long before the session ends: a launcher closes
 *  just before its game opens, and a game may restart itself. */
export const EXIT_GRACE_MS = 3000

export type WallpaperMode = "artwork" | "custom" | "none"

export interface GameWindow {
    address: string
    /** Steam's app id, when the window has one (for its artwork). */
    appId: string | null
    /** The output it is on. */
    output: string
}

/** Settings → Gaming, read when a session starts — except `silenceNotifications`, read
 *  each time a notification arrives. */
export interface GameChoices {
    wallpaperMode: WallpaperMode
    customWallpaper: string
    performanceProfile: boolean
    silenceNotifications: boolean
}

/** What a session changed, so it can be undone — by this shell or the next one. */
export interface SessionRecord {
    /** The profile before the game; null if the session did not touch it. */
    prevProfile: string | null
    /** The output whose wallpaper the session replaced; null if none. */
    wallpaperOutput: string | null
}

export interface GameWorld {
    choices(): GameChoices
    /** The active power profile; "" when there is no power-profiles-daemon. */
    readProfile(): Promise<string>
    setProfile(profile: string): Promise<void>
    /** The game's artwork on disk (Steam's library hero image), or null. */
    artworkFor(appId: string): string | null
    fileExists(path: string): boolean
    /** Shows `path` on `output` without making it the wallpaper. */
    showWallpaper(path: string, output: string): Promise<void>
    /** Puts the wallpaper back on `output`. */
    restoreWallpaper(output: string): Promise<void>
    focusedWorkspace(): { id: number; name: string } | null
    focusWorkspace(id: number): Promise<unknown>
    /** Persist the record (null = no session). */
    save(record: SessionRecord | null): void
    /** Runs `fn` after `ms`; returns a function that cancels it. */
    later(ms: number, fn: () => void): () => void
}

export class GameSessionLogic {
    /** A game is running, or the last one closed less than EXIT_GRACE_MS ago. */
    active = false
    private record: SessionRecord | null = null
    private lastWorkspace: number | null = null
    private cancelExit: (() => void) | null = null
    /** Entering and leaving are async (the profile is a D-Bus round trip): one at a time,
     *  in order, so leaving always undoes a FINISHED entry. */
    private queue: Promise<void> = Promise.resolve()

    /** `adopted`: a session a previous shell left recorded. It is this one's now — kept if
     *  a game is still up at the first `update`, undone after the grace if not. */
    constructor(private readonly world: GameWorld, adopted: SessionRecord | null = null) {
        if (adopted) {
            this.active = true
            this.record = adopted
        }
    }

    /** Notifications are held back: a session is on and Settings asks for it. */
    silencing(): boolean {
        return this.active && this.world.choices().silenceNotifications
    }

    /** The windows on `gamespace` now. Call it after every change of windows or focus. */
    update(games: GameWindow[]) {
        const ws = this.world.focusedWorkspace()
        if (ws && ws.name !== GAME_WORKSPACE && ws.id > 0) this.lastWorkspace = ws.id

        if (games.length > 0) {
            if (this.cancelExit) { this.cancelExit(); this.cancelExit = null }
            if (!this.active) {
                this.active = true
                const first = games[0]
                this.enqueue(() => this.enter(first))
            }
        } else if (this.active && !this.cancelExit) {
            this.cancelExit = this.world.later(EXIT_GRACE_MS, () => {
                this.cancelExit = null
                this.active = false
                this.enqueue(() => this.leave())
            })
        }
    }

    /** Resolves when everything started so far has finished (for the probe). */
    settled(): Promise<void> {
        return this.queue
    }

    private enqueue(step: () => Promise<void>) {
        this.queue = this.queue.then(step).catch(e => console.error("[GameSession]", e))
    }

    private async enter(game: GameWindow) {
        const w = this.world
        const c = w.choices()
        const rec: SessionRecord = { prevProfile: null, wallpaperOutput: null }
        this.record = rec

        if (c.performanceProfile) {
            const before = await w.readProfile()
            if (before !== "") {
                rec.prevProfile = before
                w.save(rec)
                if (before !== "performance") await w.setProfile("performance")
            }
        }

        let path: string | null = null
        if (c.wallpaperMode === "artwork" && game.appId) path = w.artworkFor(game.appId)
        else if (c.wallpaperMode === "custom" && c.customWallpaper && w.fileExists(c.customWallpaper)) path = c.customWallpaper
        if (path) {
            rec.wallpaperOutput = game.output
            w.save(rec)
            await w.showWallpaper(path, game.output)
        }
    }

    private async leave() {
        const w = this.world
        const rec = this.record
        this.record = null

        if (rec?.prevProfile && rec.prevProfile !== "performance" && await w.readProfile() === "performance")
            await w.setProfile(rec.prevProfile)
        if (rec?.wallpaperOutput) await w.restoreWallpaper(rec.wallpaperOutput)
        w.save(null)

        const ws = w.focusedWorkspace()
        if (ws?.name === GAME_WORKSPACE && this.lastWorkspace !== null) await w.focusWorkspace(this.lastWorkspace)
    }
}
