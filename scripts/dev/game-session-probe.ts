// game-session-probe.ts — game mode's session, driven against a fake world (a CI gate).
//
// What game mode does around a game (ui/shell/core/game-session-logic.ts) only runs when a
// game opens, which is not something a test can arrange. So it fakes the WORLD instead of
// the game: a power-profiles daemon that remembers the profile, an awww that remembers what
// each output shows, a compositor with a focused workspace, timers that fire when told. The
// logic is driven with game windows appearing and going, and the probe asserts what the
// Lua it replaced was fixed to do one bug at a time — above all, that a session is UNDONE.
//
//   npx --yes esbuild@0.28.2 scripts/dev/game-session-probe.ts --bundle --platform=node \
//       --format=esm --outfile=/tmp/game-session-probe.mjs && node /tmp/game-session-probe.mjs
//
// Exits 1 on any failure. It touches nothing real: no powerprofilesctl, no awww, no files.

import {
    EXIT_GRACE_MS, GAME_WORKSPACE, GameSessionLogic, type GameChoices, type GameWindow,
    type GameWorld, type SessionRecord,
} from "../../ui/shell/core/game-session-logic"

let failures = 0
function check(name: string, got: unknown, want: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(58)} ${ok ? JSON.stringify(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// ── The fake world ───────────────────────────────────────────────────────────

class Fake implements GameWorld {
    profile = "balanced"
    /** "" = no power-profiles-daemon. */
    hasDaemon = true
    profileWrites: string[] = []
    shown = new Map<string, string>()        // output → what awww shows
    wallpaper = "/home/u/wall.jpg"
    workspace = { id: 2, name: "2" }
    focusRequests: number[] = []
    saved: SessionRecord | null = null
    timers: (() => void)[] = []
    artwork: Record<string, string> = { "440": "/steam/440/library_hero.jpg" }
    files = new Set<string>(["/home/u/custom.png"])
    c: GameChoices = { wallpaperMode: "none", customWallpaper: "", performanceProfile: true, silenceNotifications: true }

    choices() { return { ...this.c } }
    async readProfile() { return this.hasDaemon ? this.profile : "" }
    async setProfile(p: string) { this.profileWrites.push(p); this.profile = p }
    artworkFor(appId: string) { return this.artwork[appId] ?? null }
    fileExists(p: string) { return this.files.has(p) }
    async showWallpaper(path: string, output: string) { this.shown.set(output, path) }
    async restoreWallpaper(output: string) { this.shown.set(output, this.wallpaper) }
    focusedWorkspace() { return this.workspace }
    async focusWorkspace(id: number) { this.focusRequests.push(id); this.workspace = { id, name: String(id) } }
    save(r: SessionRecord | null) { this.saved = r ? { ...r } : null }
    later(_ms: number, fn: () => void) {
        let live = true
        this.timers.push(() => { if (live) fn() })
        return () => { live = false }
    }
    /** The grace runs out. */
    fireTimers() { const t = this.timers; this.timers = []; for (const f of t) f() }
}

const GAME: GameWindow = { address: "a1", appId: "440", output: "DP-1" }
const LAUNCHER: GameWindow = { address: "a0", appId: "440", output: "DP-1" }

/** A game opens (the compositor shows gamespace), plays, and closes; the grace runs out. */
async function playAndQuit(w: Fake, s: GameSessionLogic, game: GameWindow = GAME) {
    s.update([])                       // the user is on their workspace: remembered
    w.workspace = { id: -1337, name: GAME_WORKSPACE }
    s.update([game])
    await s.settled()
    s.update([])
    w.fireTimers()
    await s.settled()
}

// ── The power profile: what it was before is what it is after ────────────────

console.log("the power profile")
for (const before of ["power-saver", "balanced", "performance"]) {
    const w = new Fake(); w.profile = before
    const s = new GameSessionLogic(w)
    await playAndQuit(w, s)
    check(`${before} survives a game session`, w.profile, before)
}
{
    const w = new Fake(); w.profile = "power-saver"
    const s = new GameSessionLogic(w)
    w.workspace = { id: -1337, name: GAME_WORKSPACE }
    s.update([GAME])
    await s.settled()
    check("mid-session the profile is performance", w.profile, "performance")
    s.update([LAUNCHER, GAME])         // a second window of the same game
    await s.settled()
    s.update([]); w.fireTimers(); await s.settled()
    check("two windows, one game: still restored", w.profile, "power-saver")
}
{
    const w = new Fake(); w.profile = "balanced"
    const s = new GameSessionLogic(w)
    s.update([GAME]); await s.settled()
    w.profile = "power-saver"          // the user picks one in Settings mid-game
    s.update([]); w.fireTimers(); await s.settled()
    check("a profile chosen mid-game is not undone", w.profile, "power-saver")
}
{
    const w = new Fake(); w.profile = "power-saver"; w.c.performanceProfile = false
    const s = new GameSessionLogic(w)
    await playAndQuit(w, s)
    check("setting off: the profile is never written", w.profileWrites, [])
}
{
    const w = new Fake(); w.hasDaemon = false
    const s = new GameSessionLogic(w)
    await playAndQuit(w, s)
    check("no power-profiles-daemon: nothing written", w.profileWrites, [])
}

// ── The wallpaper ────────────────────────────────────────────────────────────

console.log("the wallpaper")
{
    const w = new Fake(); w.c.wallpaperMode = "artwork"
    const s = new GameSessionLogic(w)
    s.update([GAME]); await s.settled()
    check("artwork: the game's hero image on its output", w.shown.get("DP-1"), "/steam/440/library_hero.jpg")
    s.update([]); w.fireTimers(); await s.settled()
    check("…and the wallpaper back afterwards", w.shown.get("DP-1"), w.wallpaper)
}
{
    const w = new Fake(); w.c.wallpaperMode = "artwork"
    const s = new GameSessionLogic(w)
    await playAndQuit(w, s, { address: "x", appId: null, output: "DP-1" })
    check("artwork, a game with no Steam id: nothing shown", w.shown.size, 0)
}
{
    const w = new Fake(); w.c.wallpaperMode = "custom"; w.c.customWallpaper = "/home/u/custom.png"
    const s = new GameSessionLogic(w)
    s.update([{ address: "x", appId: null, output: "HDMI-A-1" }]); await s.settled()
    check("custom: the chosen image, on the game's output", w.shown.get("HDMI-A-1"), "/home/u/custom.png")
}
{
    const w = new Fake(); w.c.wallpaperMode = "custom"; w.c.customWallpaper = "/gone.png"
    const s = new GameSessionLogic(w)
    await playAndQuit(w, s)
    check("custom image deleted: nothing shown, nothing to undo", w.shown.size, 0)
}

// ── Undoing the session and taking the user back are two jobs ─────────────────

console.log("leaving")
{
    const w = new Fake(); w.profile = "balanced"
    const s = new GameSessionLogic(w)
    s.update([])                                          // on workspace 2
    w.workspace = { id: -1337, name: GAME_WORKSPACE }
    s.update([GAME]); await s.settled()
    check("focus back to where the user was", (await playAndQuitTail(w, s)), [2])
}
{
    const w = new Fake(); w.profile = "balanced"
    const s = new GameSessionLogic(w)
    s.update([])
    w.workspace = { id: -1337, name: GAME_WORKSPACE }
    s.update([GAME]); await s.settled()
    w.workspace = { id: 4, name: "4" }                    // the user wandered off
    s.update([GAME])
    s.update([]); w.fireTimers(); await s.settled()
    check("quit from elsewhere: the session is still undone", w.profile, "balanced")
    check("…and the user is left where they are", w.focusRequests, [])
}
{
    const w = new Fake()
    const s = new GameSessionLogic(w)
    s.update([GAME]); await s.settled()
    s.update([])                                          // the launcher closes…
    s.update([GAME])                                      // …and the game opens, within the grace
    w.fireTimers(); await s.settled()
    check("a window that comes back within the grace keeps the session", s.active, true)
    check("…without entering twice", w.profileWrites, ["performance"])
}

// ── Notifications ────────────────────────────────────────────────────────────

console.log("notifications")
{
    const w = new Fake()
    const s = new GameSessionLogic(w)
    check("no game: not silenced", s.silencing(), false)
    s.update([GAME])
    check("a game: silenced", s.silencing(), true)
    w.c.silenceNotifications = false
    check("setting turned off mid-game: at once", s.silencing(), false)
    w.c.silenceNotifications = true
    s.update([]); w.fireTimers(); await s.settled()
    check("game over: not silenced", s.silencing(), false)
}

// ── A shell that restarts mid-session ─────────────────────────────────────────

console.log("a restart in the middle")
{
    const w = new Fake(); w.profile = "power-saver"; w.c.wallpaperMode = "artwork"
    const s = new GameSessionLogic(w)
    s.update([GAME]); await s.settled()
    check("the session is recorded as it goes", w.saved, { prevProfile: "power-saver", wallpaperOutput: "DP-1" })
    // The shell dies here. The next one adopts the record instead of capturing "performance".
    const next = new GameSessionLogic(w, w.saved)
    next.update([GAME]); await next.settled()
    check("adopting: nothing entered twice", w.profileWrites, ["performance"])
    next.update([]); w.fireTimers(); await next.settled()
    check("…and the next shell undoes it", [w.profile, w.shown.get("DP-1")], ["power-saver", w.wallpaper])
    check("…and clears the record", w.saved, null)
}
{
    const w = new Fake(); w.profile = "performance"
    // The game closed while no shell was running.
    const s = new GameSessionLogic(w, { prevProfile: "balanced", wallpaperOutput: null })
    s.update([]); w.fireTimers(); await s.settled()
    check("adopted with no game left: undone after the grace", w.profile, "balanced")
}

check("the grace is long enough for a launcher to hand over", EXIT_GRACE_MS >= 2000, true)

async function playAndQuitTail(w: Fake, s: GameSessionLogic) {
    s.update([]); w.fireTimers(); await s.settled()
    return w.focusRequests
}

console.log(failures === 0 ? "\nall good" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
