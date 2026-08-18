// wp-probe.ts — exercises core/wireplumber.ts (the AstalWp replacement) against
// the live PipeWire graph, in a process of its own.
//
//   scripts/bundle.sh scripts/dev/wp-probe.ts /tmp/wp-probe
//   /tmp/wp-probe                      # from the repo root
//   /tmp/wp-probe --linear             # negative control, see below
//
// It imports `core/wireplumber` and nothing else from the shell — in particular
// NOT `core/AudioService`, which pulls in `AppService` and would then need a
// display open BEFORE the import (the trap apps-probe documents). This file needs
// no display and no GTK.
//
// It touches the machine's real volume and briefly plays silence. Everything it
// changes it changes back, and the last check asserts the restore actually landed.
//
// What it has to show, in order:
//
//   - the graph is ours to read: sinks and sources with ids and labels;
//   - the volume we report is the CUBIC one — the same number `wpctl` prints.
//     This is the check that matters most: `mixer-api` starts in LINEAR scale and
//     a module that forgets to change it is not broken in any visible way, it just
//     reads 64 % where the system says 86 %;
//   - a volume changed from OUTSIDE (wpctl) reaches us as exactly ONE
//     notify::volume carrying the new value — the reactivity the whole shell rides
//     on, and the thing a polling implementation would fake;
//   - a volume WE set lands on the graph, and an uneven left/right balance
//     survives it (we scale channels proportionally instead of levelling them);
//   - mute round-trips both ways;
//   - a per-app stream appears with its label and its declared icon, and leaves.
//
// ⚠️ Prove it can FAIL before believing a green run. TWO controls, because they
// distinguish different pairs of worlds:
//
//   PIPEWIRE_REMOTE=nonexistent /tmp/wp-probe
//     takes the graph away. `core/wireplumber.ts` cannot connect, `getDefault()`
//     returns null, and the PRECONDITION fails hard — deliberately not "0 checks
//     ran, all green", which is what an empty roster would have looked like.
//
//   /tmp/wp-probe --linear
//     leaves the module alone and makes the probe compare `wpctl` against a
//     LINEAR reading of the same node, taken through the probe's own mixer. The
//     scale checks must go RED. A run where they stay green means the comparison
//     is not actually comparing anything.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { getDefault } from "../../ui/shell/core/wireplumber"

const LINEAR_CONTROL = ARGV.includes("--linear")

let pass = 0
let fail = 0

function check(ok: boolean, label: string, detail = ""): boolean {
    if (ok) { pass++; print(`  PASS  ${label}${detail ? "  — " + detail : ""}`) }
    else { fail++; print(`  FAIL  ${label}${detail ? "  — " + detail : ""}`) }
    return ok
}

function section(title: string): void {
    print(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`)
}

// ── Shelling out to the reference implementations ────────────────────────────

function sh(cmd: string[]): string {
    try {
        const [, out] = GLib.spawn_sync(null, cmd, null, GLib.SpawnFlags.SEARCH_PATH, null)
        return new TextDecoder().decode(out ?? new Uint8Array()).trim()
    } catch (e) {
        print(`  (spawn failed: ${cmd.join(" ")} — ${e})`)
        return ""
    }
}

/** `wpctl get-volume` prints "Volume: 0.86", or "Volume: 0.86 [MUTED]". */
function wpctlVolume(id: number): { volume: number, muted: boolean } | null {
    const out = sh(["wpctl", "get-volume", String(id)])
    const m = /Volume:\s*([0-9.]+)/.exec(out)
    if (!m) return null
    return { volume: parseFloat(m[1]), muted: out.includes("[MUTED]") }
}

/** `wpctl inspect @DEFAULT_AUDIO_SINK@` opens with "id 64, type …". */
function wpctlDefaultSinkId(): number {
    const m = /^id (\d+)/.exec(sh(["wpctl", "inspect", "@DEFAULT_AUDIO_SINK@"]))
    return m ? Number(m[1]) : 0
}

/** Per-channel volumes as PulseAudio reports them, for the balance check.
 *  `pactl list sinks` prints "Volume: front-left: 39321 /  60% / …". */
function pactlChannelPercents(nodeName: string): number[] {
    const out = sh(["pactl", "list", "sinks"])
    const blocks = out.split(/\n(?=Sink #)/)
    for (const b of blocks) {
        if (!b.includes(nodeName)) continue
        const line = /\n\s*Volume:([^\n]*)/.exec(b)
        if (!line) return []
        return [...line[1].matchAll(/\/\s*(\d+)%/g)].map(m => Number(m[1]))
    }
    return []
}

// ── Async plumbing ───────────────────────────────────────────────────────────

const loop = new GLib.MainLoop(null, false)

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE })
    })
}

/** Poll until `fn()` is truthy, or give up. Returns what `fn` last returned. */
async function until<T>(fn: () => T, ms = 5000, step = 100): Promise<T> {
    const deadline = GLib.get_monotonic_time() + ms * 1000
    let v = fn()
    while (!v && GLib.get_monotonic_time() < deadline) {
        await sleep(step)
        v = fn()
    }
    return v
}

// ── A second, independent mixer in LINEAR scale ──────────────────────────────
// Only for the --linear control: it reads the same node the way the module would
// if it had left `mixer-api` at its own default.

async function linearReader(): Promise<((id: number) => number | null) | null> {
    const Wp = (await import("gi://Wp?version=0.5")).default as any
    // ⚠️ NO second `Wp.init()`. It calls `g_log_set_writer_func()`, which GLib
    // permits exactly once per process — a second call ABORTS the probe outright
    // (measured: "g_log_set_writer_func() called multiple times", core dumped).
    // `core/wireplumber.ts` already initialised the library in this process.
    const core = Wp.Core.new(null, null, null)
    if (!core.connect()) return null            // PipeWire's connect, not GObject's
    const ready = new Promise<any>(resolve => {
        core.load_component("libwireplumber-module-mixer-api", "module", null, "mixer-api", null,
            (_o: any, res: any) => {
                try { core.load_component_finish(res) } catch { resolve(null); return }
                const p = Wp.Plugin.find(core, "mixer-api")
                if (!p) { resolve(null); return }
                p.activate(Wp.PluginFeatures.ENABLED, null, (_p: any, r: any) => {
                    try { p.activate_finish(r) } catch { resolve(null); return }
                    resolve(p)                    // left at scale 0 = linear, on purpose
                })
            })
    })
    const plugin = await ready
    if (!plugin) return null
    return (id: number) => {
        const v = plugin.emit("get-volume", id)
        return v ? v.recursiveUnpack().volume : null
    }
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    print(`wp-probe — core/wireplumber.ts against the live graph${LINEAR_CONTROL ? "   [--linear NEGATIVE CONTROL: the scale checks must FAIL]" : ""}`)

    section("precondition")
    const audio = getDefault()
    if (!check(!!audio, "PipeWire is reachable (getDefault() returned a graph)")) {
        print("\nPRECONDITION FAILED — nothing below can mean anything. Stopping.")
        return
    }

    // The roster fills on the main loop, exactly as AstalWp's did.
    const speakers = await until(() => {
        const s = audio!.get_speakers()
        return s.length > 0 ? s : null
    })
    if (!check(!!speakers, "the roster populated within 5 s")) return

    section("roster")
    check(speakers!.length > 0, "at least one sink", `${speakers!.length} sink(s)`)
    check(speakers!.every(s => s.id > 0), "every sink has a pipewire id")
    check(speakers!.every(s => (s.description ?? "") !== ""), "every sink has a label",
        speakers!.map(s => `${s.id}:${s.description}`).join(" · "))
    const mics = audio!.get_microphones()
    check(mics.length > 0, "at least one source", `${mics.length} source(s)`)

    section("the default sink")
    const wpctlId = wpctlDefaultSinkId()
    const def = audio!.default_speaker
    if (!check(!!def, "we have a default speaker")) return
    check(def!.id === wpctlId, "our default sink is wpctl's default sink",
        `ours ${def!.id}, wpctl ${wpctlId}`)

    const original = wpctlVolume(def!.id)
    if (!check(!!original, "wpctl can read that sink")) return

    section("scale — the one that silently shifts every volume in the UI")
    const linearRead = LINEAR_CONTROL ? await linearReader() : null
    const readForCompare = () => {
        if (!LINEAR_CONTROL) return def!.volume
        return linearRead ? linearRead(def!.id) ?? -1 : -1
    }
    const mine = readForCompare()
    check(Math.abs(mine - original!.volume) < 0.005,
        `the volume we report is the one wpctl prints${LINEAR_CONTROL ? " (reading LINEAR on purpose)" : ""}`,
        `ours ${mine.toFixed(4)}, wpctl ${original!.volume.toFixed(4)}`)
    check(def!.mute === original!.muted, "our mute is wpctl's mute",
        `ours ${def!.mute}, wpctl ${original!.muted}`)

    section("an outside change reaches us")
    let notifies = 0
    let lastSeen = -1
    const notifyId = def!.connect("notify::volume", () => { notifies++; lastSeen = def!.volume })
    const target = Math.abs(original!.volume - 0.42) < 0.02 ? 0.55 : 0.42
    sh(["wpctl", "set-volume", String(def!.id), String(target)])
    await until(() => notifies > 0, 2000)
    await sleep(300)                            // let any extra notify land before counting
    check(notifies === 1, "exactly one notify::volume for one outside change", `${notifies} notify`)
    check(Math.abs(lastSeen - target) < 0.005, "and it carried the new value",
        `saw ${lastSeen.toFixed(4)}, set ${target}`)

    section("a change WE make lands on the graph")
    const ours = target === 0.42 ? 0.63 : 0.37
    def!.volume = ours
    await sleep(300)
    const after = wpctlVolume(def!.id)
    check(!!after && Math.abs(after.volume - ours) < 0.005, "wpctl sees the volume we wrote",
        `wrote ${ours}, wpctl ${after?.volume}`)

    section("mute round-trips")
    def!.mute = true
    await sleep(300)
    check(wpctlVolume(def!.id)?.muted === true, "wpctl sees the mute we wrote")
    def!.mute = false
    await sleep(300)
    check(wpctlVolume(def!.id)?.muted === false, "and the unmute")

    section("an uneven balance survives our write")
    // Set the two channels apart with pactl, then move the node's volume with OUR
    // setter: a flat `volume` key would level them, the proportional write keeps
    // the ratio. Skipped rather than faked where pactl or stereo is missing.
    const sinkName = sh(["wpctl", "inspect", String(def!.id)])
    const nameMatch = /node\.name = "([^"]+)"/.exec(sinkName)
    if (!nameMatch) {
        print("  SKIP  no node.name for the default sink — balance check needs pactl by name")
    } else {
        sh(["pactl", "set-sink-volume", nameMatch[1], "40%", "20%"])
        await sleep(400)
        const before = pactlChannelPercents(nameMatch[1])
        if (before.length < 2 || before[0] === before[1]) {
            print(`  SKIP  the default sink is not stereo-with-balance here (${before.join("/")})`)
        } else {
            def!.volume = def!.volume * 0.5
            await sleep(400)
            const afterPct = pactlChannelPercents(nameMatch[1])
            const ratioBefore = before[1] / before[0]
            const ratioAfter = afterPct.length >= 2 ? afterPct[1] / afterPct[0] : -1
            check(Math.abs(ratioAfter - ratioBefore) < 0.06,
                "left/right ratio is preserved through our write",
                `${before.join("/")}% → ${afterPct.join("/")}%`)
        }
    }

    section("a per-app stream appears and leaves")
    let added: any = null
    let removed: any = null
    const addId = audio!.connect("stream-added", (_a: any, s: any) => { added = s })
    const remId = audio!.connect("stream-removed", (_a: any, s: any) => { removed = s })

    // Silence, with an icon declared the way a real client declares one.
    const player = Gio.Subprocess.new(
        ["env", "PIPEWIRE_PROPS={ media.icon-name = nidara-probe-icon }",
         "pw-cat", "-p", "--format", "s16", "--rate", "48000", "--channels", "2",
         "--raw", "/dev/zero"],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)

    const ourStream = await until(() => {
        const s = audio!.get_streams().find((s: any) => s.description === "pw-cat")
        return s ?? null
    }, 6000)
    if (check(!!ourStream, "the stream shows up in the roster")) {
        check(added !== null, "and stream-added fired for it")
        // node.description is EMPTY on a stream — measured, and the reason the
        // fallback chain exists. The label the UI shows comes from node.name.
        check(ourStream!.description === "pw-cat", "its label falls back to node.name",
            `description="${ourStream!.description}"`)
        check(ourStream!.name === "/dev/zero", "and media.name is the stream's own name",
            `name="${ourStream!.name}"`)
        check(ourStream!.icon === "nidara-probe-icon", "its DECLARED icon wins",
            `icon="${ourStream!.icon}"`)
    }

    player.force_exit()
    await until(() => removed !== null, 5000)
    check(removed !== null, "stream-removed fires when it goes away")
    audio!.disconnect(addId)
    audio!.disconnect(remId)

    section("restore")
    def!.disconnect(notifyId)
    sh(["wpctl", "set-volume", String(def!.id), String(original!.volume)])
    sh(["wpctl", "set-mute", String(def!.id), original!.muted ? "1" : "0"])
    await sleep(400)
    const back = wpctlVolume(def!.id)
    check(!!back && Math.abs(back.volume - original!.volume) < 0.01 && back.muted === original!.muted,
        "the machine is back where it started",
        `${back?.volume} (was ${original!.volume}), muted=${back?.muted}`)

    print(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`)
    if (LINEAR_CONTROL && fail === 0) {
        print("⚠️  --linear was supposed to FAIL the scale check. A green run here means")
        print("    the comparison is inert and the real run's green proves nothing.")
    }
}

main()
    .catch(e => { print(`\nprobe threw: ${e}\n${e.stack}`); fail++ })
    .finally(() => loop.quit())

loop.run()
imports.system.exit(fail === 0 ? 0 : 1)
