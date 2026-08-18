// AudioService — the single source of audio (PipeWire/WirePlumber) domain logic.
//
// Same stateless-facade pattern as NetworkService / BluetoothService: the layer
// below (`core/wireplumber.ts` — ours since 2026-08-18, when it replaced AstalWp)
// is already a reactive singleton, so this just owns the volume→icon mapping, the
// per-app stream icon resolution, the set-default command, endpoint/stream list
// accessors, and notify-subscription helpers. The Settings → Audio page, the CC
// volume tile/detail (Sliders.tsx + volume.ts) and the bar volume widget consume
// these instead of re-deriving the same volume-icon ladder (it lived in FOUR
// near-identical copies) and re-wiring the same WirePlumber signals.
//
// Returns Gio icons via core/Icons (core→core, fine). Never imports Gtk — the
// slider *widget* helper lives in common/Slider.ts (makeVolumeSlider).

import { execAsync } from "../../lib/process"
import { getDefault, AudioNode } from "./wireplumber"
import Icons from "./Icons"
import { safeDisconnect } from "./signals"
import { appService } from "./AppService"

/** The graph. Null only if PipeWire is not reachable at all. */
export function audio(): any {
    return getDefault()
}

/** Re-exported so surfaces can name an endpoint/stream without importing the
 *  WirePlumber layer — the facade rule: nothing outside `core/` says `gi://Wp`. */
export type { AudioNode }

// ── Derivations ──────────────────────────────────────────────────────────────

/** Volume-level icon. Same ladder for outputs and inputs (a muted mic reads
 *  better as volume-muted than a plain mic glyph). */
export function volumeIcon(volume: number, muted = false) {
    if (muted || volume === 0) return Icons.volumeMuted
    if (volume < 0.34) return Icons.volumeLow
    if (volume < 0.67) return Icons.volumeMedium
    return Icons.volumeHigh
}

/** Same, reading `.volume`/`.mute` straight off an endpoint or stream object. */
export function targetVolumeIcon(target: any) {
    return volumeIcon(target?.volume ?? 0, target?.mute ?? false)
}

/** Per-app stream icon name.
 *
 *  TWO measured facts about what the graph hands us, both of which broke the
 *  obvious implementation (verified live 2026-08-02 against the real graph):
 *
 *  - **The app's name is `description`, not `name`.** `name` is the STREAM's name
 *    — "Playback Stream", "Playback". `description` is the client: "Clocks",
 *    "Google Chrome".
 *  - **`icon` is never empty.** A client that declared no icon of its own gets
 *    `application-x-executable-symbolic` — a real, resolvable theme name for
 *    the generic app glyph. So "did the client tell us its icon?" cannot be
 *    answered by an emptiness check: GNOME Clocks played audio under a GEAR
 *    because that placeholder was taken for an answer. Hence
 *    `isGenericIconName` — the placeholder is a NO, not an icon.
 *
 *  So: declared icon (Chrome sets `google-chrome`) → desktop registry by app name
 *  → a generic audio glyph for a stream that belongs to nothing we can name.
 */
export function streamIconName(stream: any): string {
    const declared: string = stream.icon ?? ""
    if (declared && !appService.isGenericIconName(declared)) return declared
    return appService.iconForAppName(stream.description ?? "") ?? "audio-x-generic-symbolic"
}

// ── Endpoint / stream accessors ──────────────────────────────────────────────

export function speakers(a: any = audio()): any[] { return a?.get_speakers?.() ?? [] }
export function microphones(a: any = audio()): any[] { return a?.get_microphones?.() ?? [] }
export function streams(a: any = audio()): any[] { return a?.get_streams?.() ?? [] }
export function defaultSpeaker(a: any = audio()): any { return a?.default_speaker ?? null }
export function defaultMicrophone(a: any = audio()): any { return a?.default_microphone ?? null }

// ── Commands ─────────────────────────────────────────────────────────────────

/** Make an endpoint the default. `wpctl set-default` is the most reliable path
 *  across PipeWire versions, and it has been the write half here since long before
 *  the read half became ours — `default-nodes-api` also exposes
 *  `set-default-configured-node-name`, but wpctl is what the rest of the system
 *  agrees with. */
export function setDefault(endpoint: any): void {
    execAsync(["wpctl", "set-default", String(endpoint.id)])
        .catch(e => console.error("[Audio] set-default failed:", e))
}

export function toggleMute(target: any): void {
    if (target) target.mute = !(target.mute ?? false)
}

// ── Reactivity helpers ───────────────────────────────────────────────────────
// Return a disposer; callers wire it to a widget's `unrealize`.

type Dispose = () => void

function wire(obj: any, sigs: string[], cb: () => void): Dispose {
    if (!obj?.connect) return () => {}
    const ids: number[] = []
    for (const s of sigs) { try { ids.push(obj.connect(s, cb)) } catch {} }
    return () => ids.forEach(id => safeDisconnect(obj, id))
}

/** Fires when the speaker/mic set or the default endpoint changes. */
export function watchDevices(cb: () => void, a: any = audio()): Dispose {
    return wire(a, [
        "speaker-added", "speaker-removed",
        "microphone-added", "microphone-removed",
        "notify::default-speaker", "notify::default-microphone",
    ], cb)
}

/** Fires when a per-app playback stream appears/disappears. */
export function watchStreams(cb: () => void, a: any = audio()): Dispose {
    return wire(a, ["stream-added", "stream-removed"], cb)
}

/** Fires on an endpoint/stream's own volume or mute change. */
export function watchVolume(target: any, cb: () => void): Dispose {
    return wire(target, ["notify::volume", "notify::mute"], cb)
}

/** Fires on the volume/mute of whichever endpoint is CURRENTLY the default
 *  speaker — following the default when it changes, and priming on subscribe.
 *
 *  🔑 Use this instead of `watchVolume(defaultSpeaker(), cb)`. Four widgets wrote
 *  that line by hand and three of them were broken by it in the same way: it
 *  resolves the endpoint ONCE, at build or at realize, and a CC spec is built at
 *  shell start — when PipeWire may not have answered yet. `watchVolume(null, …)`
 *  is a silent no-op, so the widget looked subscribed and never heard anything
 *  again (measured on screen: the bar icon stuck on MUTED with the sink at 95 %,
 *  and the CC gauge frozen at its first paint while its own label kept up). It is
 *  also what makes a widget follow the user switching output device. */
export function watchDefaultSpeaker(cb: () => void): Dispose {
    let stopVolume: Dispose | null = null
    const rewire = () => {
        stopVolume?.()
        stopVolume = watchVolume(defaultSpeaker(), cb)
        cb()
    }
    rewire()
    const stopDevices = watchDevices(rewire)
    return () => { stopVolume?.(); stopDevices() }
}
