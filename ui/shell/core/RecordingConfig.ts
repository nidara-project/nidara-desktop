// Screen-recording settings + the wf-recorder command they build.
//
// The widget owns the two decisions you make AT capture time (full screen or
// region, audio on or off); everything that is a PREFERENCE — which audio
// source, what quality, what container, where files land — lives here and is
// persisted, exactly like NotifConfig. The widget's Settings subpage
// (screenrecord.ts buildSettings) is the UI over this module.
//
// Everything below was measured against wf-recorder 0.6.0, not assumed:
//   • `--audio` with NO device records the DEFAULT PulseAudio SOURCE — a
//     microphone, never the desktop. Capturing what you hear means naming the
//     default sink's `.monitor` explicitly, which is why audioSource exists and
//     defaults to AUDIO_SYSTEM.
//   • The long option takes an OPTIONAL argument (getopt), so the device only
//     binds in the `--audio=NAME` form. `["--audio", name]` as two argv entries
//     silently falls back to the default source.
//   • An unknown device name does NOT fail: pipewire-pulse quietly substitutes
//     the default source, so a stale saved device records the wrong thing
//     instead of erroring. resolveAudioDevice() therefore verifies the name is
//     still present and falls back to system audio when it is not.
//   • VAAPI encodes H.264 here, but `vp9_vaapi` returns "Function not
//     implemented" on Navi 10 — hardware encoding is offered for the H.264
//     containers only (see CODECS), never for WebM.

import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"
import { execAsync } from "ags/process"
import { loadKnown } from "./configFile"

export type RecordQuality = "low" | "balanced" | "high"
export type RecordFormat = "mp4" | "mkv" | "webm"

/** The two LOGICAL audio sources, resolved to a real device at capture time so
 *  the setting keeps meaning after the user changes their default output/input.
 *  Any other value is a literal PulseAudio source name. */
export const AUDIO_SYSTEM = "@system"
export const AUDIO_MIC = "@mic"

export const QUALITIES: readonly RecordQuality[] = ["low", "balanced", "high"]
export const FORMATS: readonly RecordFormat[] = ["mp4", "mkv", "webm"]
/** 0 = follow the compositor: wf-recorder asks for a frame only when the screen
 *  changes, which is both the smallest file and the default. */
export const FRAMERATES: readonly number[] = [0, 30, 60]

const RENDER_NODE = "/dev/dri/renderD128"

interface RecordingSettings {
    audioSource: string
    quality: RecordQuality
    framerate: number
    hardware: boolean
    format: RecordFormat
    saveDir: string
}

export const defaultSaveDir = (): string =>
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS)
    ?? GLib.build_filenamev([GLib.get_home_dir(), "Videos"])

/** A GPU render node is the whole hardware gate — the Settings row hides when
 *  there is none, and the encoder falls back to software regardless. */
export const hardwareAvailable = (): boolean =>
    GLib.file_test(RENDER_NODE, GLib.FileTest.EXISTS)

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/recording.json`

const DEFAULTS = (): RecordingSettings => ({
    audioSource: AUDIO_SYSTEM,
    quality: "balanced",
    framerate: 0,
    hardware: hardwareAvailable(),
    format: "mp4",
    saveDir: defaultSaveDir(),
})

let _settings: RecordingSettings = DEFAULTS()
try {
    if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
        _settings = loadKnown(DEFAULTS(), JSON.parse(readFile(CONFIG_PATH)))
    }
} catch {}

function save() {
    try {
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify(_settings, null, 2))
    } catch (e) {
        console.error("[RecordingConfig] Save failed:", e)
    }
}

const _listeners = new Set<() => void>()
const notify = () => _listeners.forEach(fn => fn())

// ── Audio devices ─────────────────────────────────────────────────────────────

export interface AudioDevice {
    /** PulseAudio source name — what `--audio=` takes. */
    name: string
    /** Human label, e.g. "Monitor of Navi 10 HDMI Audio Digital Stereo". */
    description: string
    /** True for a sink monitor (desktop audio) rather than a real input. */
    monitor: boolean
}

async function pactl(args: string[]): Promise<string> {
    return (await execAsync(["pactl", ...args])).trim()
}

/** Every capturable source, monitors first (desktop audio is the common intent).
 *  Returns [] when pactl is unreachable — callers fall back to the sentinels,
 *  which never need the list. */
export async function listAudioDevices(): Promise<AudioDevice[]> {
    try {
        const raw = JSON.parse(await pactl(["-f", "json", "list", "sources"])) as any[]
        // On a SOURCE, pactl's `monitor_source` names the sink this is the
        // monitor of — "" for a real input. Confusing field name, exact test.
        const devices = raw.map(s => ({
            name: String(s.name ?? ""),
            description: String(s.description ?? s.name ?? ""),
            monitor: !!s.monitor_source,
        })).filter(d => d.name)
        return [...devices.filter(d => d.monitor), ...devices.filter(d => !d.monitor)]
    } catch (e) {
        console.error("[RecordingConfig] Listing audio sources failed:", e)
        return []
    }
}

/** Turn the stored setting into a real device name for `--audio=`. Returns null
 *  when nothing usable exists, in which case the capture runs without audio
 *  rather than recording a source the user did not choose. */
export async function resolveAudioDevice(): Promise<string | null> {
    const wanted = _settings.audioSource
    try {
        if (wanted === AUDIO_SYSTEM) {
            const sink = await pactl(["get-default-sink"])
            return sink ? `${sink}.monitor` : null
        }
        if (wanted === AUDIO_MIC) {
            return (await pactl(["get-default-source"])) || null
        }
        // A named device: verify it is still on the bus. An absent name would
        // NOT error — pipewire-pulse substitutes the default source — so the
        // check is the only thing standing between a unplugged mic and a
        // recording of something else entirely.
        const devices = await listAudioDevices()
        if (devices.some(d => d.name === wanted)) return wanted
        const sink = await pactl(["get-default-sink"])
        return sink ? `${sink}.monitor` : null
    } catch (e) {
        console.error("[RecordingConfig] Resolving audio device failed:", e)
        return null
    }
}

// ── Encoder ───────────────────────────────────────────────────────────────────

// Per container: the software encoder, the VAAPI one (null = no working
// hardware path), and the quality knob each takes. x264/VP9 use CRF (lower =
// better), VAAPI uses QP on the same polarity but a different scale, so the
// three presets are spelled out per encoder rather than mapped by formula.
interface CodecSpec {
    codec: string
    /** AVOptions passed through wf-recorder's `-p key=value`. */
    params: (q: RecordQuality) => string[]
}

const x264: CodecSpec = {
    codec: "libx264",
    params: q => [`crf=${{ low: 30, balanced: 23, high: 18 }[q]}`, "preset=veryfast"],
}
const h264Vaapi: CodecSpec = {
    codec: "h264_vaapi",
    params: q => [`qp=${{ low: 34, balanced: 26, high: 20 }[q]}`],
}
// libvpx-vp9 needs b=0 alongside crf or it silently runs in constrained-bitrate
// mode and ignores the crf entirely.
const vp9: CodecSpec = {
    codec: "libvpx-vp9",
    params: q => [`crf=${{ low: 40, balanced: 32, high: 24 }[q]}`, "b=0"],
}

const CODECS: Record<RecordFormat, { sw: CodecSpec; hw: CodecSpec | null }> = {
    mp4:  { sw: x264, hw: h264Vaapi },
    mkv:  { sw: x264, hw: h264Vaapi },
    webm: { sw: vp9,  hw: null },   // vp9_vaapi is absent on plenty of GPUs
}

/** True when the current format + hardware setting actually reach the GPU —
 *  drives the "software only for this format" hint in Settings. */
export const hardwareApplies = (): boolean =>
    CODECS[_settings.format].hw !== null && hardwareAvailable()

// ── Capture command ───────────────────────────────────────────────────────────

function timestampedFile(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    return GLib.build_filenamev([_settings.saveDir, `Recording_${ts}.${_settings.format}`])
}

export interface CaptureCommand {
    argv: string[]
    outFile: string
    /** The source actually being recorded, null when the capture is silent —
     *  the caller reports it so "audio on, nothing recorded" cannot happen quietly. */
    audioDevice: string | null
}

/** Build the full wf-recorder invocation. `region` is slurp's "x,y WxH" for a
 *  partial capture; omit it for the whole screen. */
export async function buildCaptureCommand(opts: { region?: string; audio: boolean }): Promise<CaptureCommand> {
    const s = _settings
    const argv = ["wf-recorder"]

    const audioDevice = opts.audio ? await resolveAudioDevice() : null
    // `--audio=NAME`, one argv entry: the option's argument is optional, so the
    // separated form would be parsed as a positional and the device dropped.
    if (audioDevice) argv.push(`--audio=${audioDevice}`)

    if (opts.region) argv.push("-g", opts.region)
    if (s.framerate > 0) argv.push("-r", String(s.framerate))

    const spec = CODECS[s.format]
    const useHw = s.hardware && spec.hw !== null && hardwareAvailable()
    const codec = useHw ? spec.hw! : spec.sw
    argv.push("-c", codec.codec)
    if (useHw) argv.push("-d", RENDER_NODE)
    for (const p of codec.params(s.quality)) argv.push("-p", p)

    const outFile = timestampedFile()
    GLib.mkdir_with_parents(s.saveDir, 0o755)
    argv.push("-f", outFile)

    return { argv, outFile, audioDevice }
}

// ── Public settings surface ───────────────────────────────────────────────────

export const recordingConfig = {
    get audioSource() { return _settings.audioSource },
    get quality() { return _settings.quality },
    get framerate() { return _settings.framerate },
    get hardware() { return _settings.hardware },
    get format() { return _settings.format },
    get saveDir() { return _settings.saveDir },

    setAudioSource(v: string) { _settings.audioSource = v; save(); notify() },
    setQuality(v: RecordQuality) { _settings.quality = v; save(); notify() },
    setFramerate(v: number) { _settings.framerate = Math.max(0, Math.round(v)); save(); notify() },
    setHardware(v: boolean) { _settings.hardware = v; save(); notify() },
    setFormat(v: RecordFormat) { _settings.format = v; save(); notify() },
    setSaveDir(v: string) { _settings.saveDir = v; save(); notify() },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default recordingConfig
