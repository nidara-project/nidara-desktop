// AudioService — the single source of audio (PipeWire/WirePlumber) domain logic.
//
// Same stateless-facade pattern as NetworkService / BluetoothService: AstalWp is
// already a reactive singleton, so this just owns the volume→icon mapping, the
// per-app stream icon resolution, the set-default command, endpoint/stream list
// accessors, and notify-subscription helpers. The Settings → Audio page, the CC
// volume tile/detail (Sliders.tsx + volume.ts) and the bar volume widget consume
// these instead of re-deriving the same volume-icon ladder (it lived in FOUR
// near-identical copies) and re-wiring the same WirePlumber signals.
//
// Returns Gio icons via core/Icons (core→core, fine). Never imports Gtk — the
// slider *widget* helper lives in common/Slider.ts (makeVolumeSlider).

import { execAsync } from "ags/process"
import AstalWp from "gi://AstalWp"
import Icons from "./Icons"

export function wp(): AstalWp.Wp | null {
    return AstalWp.get_default()
}

export function audio(): any {
    return AstalWp.get_default()?.audio ?? null
}

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

/** Per-app stream icon name. Prefer the real (full-colour) app icon, falling
 *  back to the app name then a generic glyph; the placeholder card icon is junk. */
export function streamIconName(stream: any): string {
    const raw: string = stream.icon ?? ""
    return (raw && raw !== "audio-card-symbolic")
        ? raw
        : (stream.name?.toLowerCase() ?? "audio-x-generic-symbolic")
}

// ── Endpoint / stream accessors ──────────────────────────────────────────────

export function speakers(a: any = audio()): any[] { return a?.get_speakers?.() ?? [] }
export function microphones(a: any = audio()): any[] { return a?.get_microphones?.() ?? [] }
export function streams(a: any = audio()): any[] { return a?.get_streams?.() ?? [] }
export function defaultSpeaker(a: any = audio()): any { return a?.default_speaker ?? null }
export function defaultMicrophone(a: any = audio()): any { return a?.default_microphone ?? null }

// ── Commands ─────────────────────────────────────────────────────────────────

/** Make an endpoint the default. `wpctl set-default` is the most reliable path
 *  across PipeWire versions (more so than poking AstalWp properties). */
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
    return () => ids.forEach(id => { try { obj.disconnect(id) } catch {} })
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
