// mpris-probe.ts — exercises core/mpris.ts (the AstalMpris replacement) against
// real MPRIS players on the real session bus, in a process of its own.
//
//   scripts/bundle.sh scripts/dev/mpris-probe.ts /tmp/mpris-probe
//   /tmp/mpris-probe                       # from the repo root
//   /tmp/mpris-probe /path/to/fake-mpris.js
//
// It spawns its own `fake-mpris.js` players, so it needs no music playing and
// leaves nothing behind. Your real players (a browser tab, Spotify) may be on
// the bus at the same time — every assertion is scoped to the probe's own bus
// names, so that is fine.
//
// What it has to show, in order:
//
//   - both fakes appear in the roster, with metadata, the ROOT interface's
//     Identity/DesktopEntry, and length converted from µs to seconds;
//   - position advances by ~1 s per second while playing and stands still while
//     paused, WITHOUT the player emitting a single notify — that silence is the
//     whole point of extrapolating instead of polling, and it is what used to
//     make every media consumer in the shell repaint at 1 Hz;
//   - a pause arrives as exactly one notify::playback-status;
//   - a seek lands on the player, through SetPosition when the track has an
//     mpris:trackid and through a relative Seek when it does not;
//   - a player that leaves the bus leaves the roster, and the roster listener
//     (the one MediaService subscribes with) fires for it.
//
// ⚠️ Prove it can FAIL before believing a green run:
//
//   DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/mpris-probe
//
// takes the session bus away from both sides — core/mpris.ts logs "[Mpris] no
// session bus" and every check below reports FAIL. A run that still says ALL
// PASS is not testing what it claims to test.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { players, subscribePlayers, PlaybackStatus } from "../../ui/shell/core/mpris"

const FAKE = ARGV[0] ?? "scripts/dev/fake-mpris.js"
const ART_A = "https://example.invalid/red.png"
const ART_B = "https://example.invalid/blue.png"

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = "") {
    if (ok) pass++; else fail++
    print(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

const sleep = (ms: number) => new Promise<void>(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE })
})

function spawnFake(args: string[], env: Record<string, string> = {}): any {
    const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_SILENCE)
    for (const [k, v] of Object.entries(env)) launcher.setenv(k, v, true)
    return launcher.spawnv(["gjs", FAKE, ...args])
}

const bus = (() => {
    try { return Gio.bus_get_sync(Gio.BusType.SESSION, null) } catch { return null }
})()

/** Ask a player for its Position directly — an independent read, so a seek is
 *  verified against the PLAYER and not against our own optimistic anchor. */
function remotePosition(busName: string): Promise<number> {
    return new Promise(resolve => {
        if (!bus) return resolve(NaN)
        bus.call(
            `org.mpris.MediaPlayer2.${busName}`, "/org/mpris/MediaPlayer2",
            "org.freedesktop.DBus.Properties", "Get",
            new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Position"]),
            new GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 2000, null,
            (_s: any, res: any) => {
                try {
                    const v = bus.call_finish(res).get_child_value(0).get_variant()
                    resolve(Number(v.get_int64()) / 1e6)
                } catch { resolve(NaN) }
            },
        )
    })
}

const find = (short: string) =>
    players().find((p: any) => p.bus_name === `org.mpris.MediaPlayer2.${short}`)

async function main() {
    let rosterEvents = 0
    subscribePlayers(() => { rosterEvents++ })

    print("spawning fake players (nidaraProbeA playing, nidaraProbeB paused)…")
    const procA = spawnFake(["nidaraProbeA", "Aurora", "Red track", "Artist A", ART_A, "Playing", "kitty"])
    const procB = spawnFake(["nidaraProbeB", "Boreal", "Blue track", "Artist B", ART_B, "Paused"])
    await sleep(1500)

    const A: any = find("nidaraProbeA")
    const B: any = find("nidaraProbeB")
    check("roster: both fakes are on it", !!A && !!B, `${players().length} player(s) total`)
    check("roster: the listener fired", rosterEvents > 0, `${rosterEvents} event(s)`)
    if (!A || !B) {
        print("PROBE-RESULT FAIL — no players reached the roster; nothing else can be tested")
        procA.force_exit(); procB.force_exit()
        return
    }

    // ── What the two interfaces answer ───────────────────────────────────────
    check("metadata: title + artist", A.title === "Red track" && A.artist === "Artist A",
        `"${A.title}" / "${A.artist}"`)
    check("root interface: identity + desktop entry", A.identity === "Aurora" && A.entry === "kitty",
        `"${A.identity}" / "${A.entry}"`)
    check("metadata: length is µs → seconds", near(A.length, 180, 0.001), `${A.length}s`)
    check("metadata: art_url passed through", A.art_url === ART_A, A.art_url)
    check("playback status per player",
        A.playback_status === PlaybackStatus.PLAYING && B.playback_status === PlaybackStatus.PAUSED,
        `${A.playback_status} / ${B.playback_status}`)
    check("can_seek from the bus, not a default", A.can_seek === true)

    // ── Position: extrapolated, and SILENT ───────────────────────────────────
    let notifies = 0
    let statusNotifies = 0
    A.connect("notify", () => { notifies++ })
    A.connect("notify::playback-status", () => { statusNotifies++ })

    const a0 = A.position
    const b0 = B.position
    print("watching a PLAYING player for 3 s…")
    await sleep(3000)
    const a1 = A.position

    check("position advances with the clock", near(a1 - a0, 3, 0.4), `${a0.toFixed(2)}s → ${a1.toFixed(2)}s`)
    check("a paused player's position stands still", near(B.position, b0, 0.01), `${B.position.toFixed(2)}s`)
    check("NO notify storm: 3 s of playback emit nothing", notifies === 0, `${notifies} notify`)

    // ── A pause is one signal, and it stops the clock ────────────────────────
    A.play_pause()
    await sleep(700)
    check("pause arrives as exactly one notify::playback-status",
        statusNotifies === 1 && A.playback_status === PlaybackStatus.PAUSED,
        `${statusNotifies} signal(s), now ${A.playback_status}`)
    const paused0 = A.position
    await sleep(1000)
    check("position freezes on pause", near(A.position, paused0, 0.02),
        `${paused0.toFixed(2)}s → ${A.position.toFixed(2)}s`)

    // ── Seeking, both ways ───────────────────────────────────────────────────
    A.position = 60
    await sleep(400)
    const remoteA = await remotePosition("nidaraProbeA")
    check("seek via SetPosition reaches the player", near(remoteA, 60, 0.3), `player says ${remoteA.toFixed(2)}s`)
    check("seek is reflected locally", near(A.position, 60, 0.3), `${A.position.toFixed(2)}s`)

    print("spawning a third fake with NO mpris:trackid (SetPosition is a no-op there)…")
    const procC = spawnFake(["nidaraProbeC", "Cirrus", "Grey track", "Artist C", "", "Paused"],
        { FAKE_MPRIS_NO_TRACKID: "1" })
    await sleep(1500)
    const C: any = find("nidaraProbeC")
    check("roster: the trackid-less fake is on it", !!C)
    if (C) {
        C.position = 45
        await sleep(400)
        const remoteC = await remotePosition("nidaraProbeC")
        check("seek falls back to a relative Seek", near(remoteC, 45, 0.3), `player says ${remoteC.toFixed(2)}s`)
    }

    // ── Leaving the bus ──────────────────────────────────────────────────────
    const before = rosterEvents
    procB.force_exit()
    await sleep(1200)
    check("a player that leaves the bus leaves the roster", !find("nidaraProbeB"))
    check("the roster listener fired for the departure", rosterEvents > before)

    procA.force_exit()
    procC?.force_exit()
    await sleep(500)

    print(`PROBE-RESULT ${fail === 0 ? "ALL PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
}

const loop = GLib.MainLoop.new(null, false)
main()
    .catch((e: any) => { print(`PROBE-RESULT FAIL — probe threw: ${e}`); fail++ })
    .finally(() => loop.quit())
loop.run()
