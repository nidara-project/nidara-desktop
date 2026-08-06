import GLib from "gi://GLib"
import type Gdk from "gi://Gdk?version=4.0"

/**
 * Thin wrapper over libnidara-wl's window capture (ext-image-copy-capture).
 *
 * Hyprland RE-RENDERS the window into an export framebuffer on demand
 * (`ScreenshareFrame.cpp` → `RPT_EXPORT`), so this does NOT read the client's
 * buffer and does NOT need the window to be visible: a window parked on a hidden
 * workspace captures its last committed content, which is exactly what a
 * thumbnail wants. The cost is ONE render pass per capture — a one-shot expense,
 * not the continuous GPU draw that Nidara's animation rule forbids. Which is why
 * this module never polls: callers capture on open and reuse the texture.
 *
 * Loaded LAZILY and tolerated missing, for the same reason as VisibleRegion.ts:
 * a checkout updated without reinstalling the typelib would otherwise take the
 * whole shell down on a static `gi://NidaraWl` import. Absent shim = every
 * capture resolves `null` and callers keep their placeholder.
 */

type Shim = {
    init(): boolean
    has_capture(): boolean
    capture_window(
        address: number,
        maxWidth: number,
        maxHeight: number,
        // A GCancellable, or null. Typed loosely on purpose: this module always
        // passes null, and naming the Gio type here would tie the shim's shape to
        // whatever @girs currently exports for it.
        cancellable: object | null,
        callback: (source: unknown, result: unknown) => void,
    ): void
    capture_window_finish(result: unknown): Gdk.Texture | null
}

const SHIM_MODULE = "gi://NidaraWl"

/**
 * Escape hatch, and the only way to A/B the feature without two builds.
 * `NIDARA_WINDOW_CAPTURE=0` keeps every surface on its placeholder.
 */
const DISABLED = GLib.getenv("NIDARA_WINDOW_CAPTURE") === "0"

/**
 * Simultaneous captures. Each one runs on a worker thread with its OWN Wayland
 * connection, so this is a real resource, not a politeness knob. Four in
 * parallel measured 68 ms total against 198 ms sequential (2026-08-04 prototype);
 * past that the compositor schedules them on its own frame clock anyway, so more
 * threads buy latency spikes rather than throughput.
 */
const MAX_INFLIGHT = 4

let shim: Shim | null = null
let loading = false
let ready: Promise<void> | null = null

function load(): Promise<void> {
    if (ready) return ready
    if (DISABLED) {
        loading = true
        console.log("[WindowCapture] disabled by NIDARA_WINDOW_CAPTURE=0 — placeholders only")
        ready = Promise.resolve()
        return ready
    }
    loading = true
    // Specifier held in a variable ON PURPOSE — see the same note in
    // VisibleRegion.ts: a literal makes tsc resolve the module at compile time,
    // turning "optional at runtime" into "typecheck fails until the .gir is
    // installed", CI included.
    ready = import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init()) throw new Error("init returned false")
            if (!wl.has_capture()) {
                console.log("[WindowCapture] compositor has no ext-image-copy-capture — placeholders only")
                return
            }
            shim = wl
            console.log("[WindowCapture] libnidara-wl ready")
        })
        .catch(e => {
            console.log(`[WindowCapture] libnidara-wl unavailable, using placeholders: ${e}`)
        })
    return ready
}

/**
 * Hyprland window addresses are hex, and the shim takes a guint64.
 *
 * 🔑 THE TWO SOURCES DISAGREE ON THE PREFIX. `hyprctl clients` and the shell's own
 * `ags request listWindows` report "0x555b0a0cad80"; the AstalHyprland client
 * objects behind `hs.clients` report the SAME address as bare "555b0a0cad80".
 * `BigInt()` accepts the first and throws `SyntaxError` on the second — so reading
 * the address from the wrong source silently captured nothing at all. Normalise
 * here rather than at the call sites, which is where it went wrong once already.
 *
 * Parsed through BigInt because a 12-16 digit hex string is past what parseInt
 * keeps exact; the Number cast back is safe for real heap addresses (< 2^48 on
 * x86-64) and is checked rather than assumed.
 */
function parseAddress(address: string): number | null {
    const hex = /^0[xX]/.test(address) ? address : `0x${address}`
    let n: bigint
    try {
        n = BigInt(hex)
    } catch (e) {
        console.warn(`[WindowCapture] unparseable window address ${JSON.stringify(address)}: ${e}`)
        return null
    }
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
        console.warn(`[WindowCapture] address ${address} exceeds the safe integer range — skipping`)
        return null
    }
    return Number(n)
}

const inflight = new Map<string, Promise<Gdk.Texture | null>>()
const queue: Array<() => void> = []
let running = 0

function pump() {
    while (running < MAX_INFLIGHT && queue.length > 0) {
        const job = queue.shift()!
        running++
        job()
    }
}

/**
 * Captures @address scaled to fit @maxWidth × @maxHeight (aspect preserved, never
 * scaled up), or resolves `null` when the shim is missing, the compositor refuses,
 * or the window is gone. Never rejects — a missing thumbnail is a placeholder, not
 * an error path for callers to handle.
 *
 * Concurrent calls for the same address share one capture.
 */
export async function captureWindow(
    address: string,
    maxWidth: number,
    maxHeight: number,
): Promise<Gdk.Texture | null> {
    await load()
    if (!shim) return null

    // Keyed by address AND size: two surfaces want the same window at different
    // scales (the overview's card and the app grid's strip), and sharing by
    // address alone would hand one of them a texture sized for the other — which
    // reads as "the big thumbnail is blurry" and points nowhere near this line.
    const key = `${address}@${maxWidth}x${maxHeight}`
    const existing = inflight.get(key)
    if (existing) return existing

    const addr = parseAddress(address)
    if (addr === null) return null

    const promise = new Promise<Gdk.Texture | null>(resolve => {
        queue.push(() => {
            // `running` is decremented in exactly one place per job. A synchronous
            // throw here would otherwise burn a slot permanently and, four windows
            // later, wedge the queue with no thumbnails and no error.
            let settled = false
            const done = (texture: Gdk.Texture | null) => {
                if (settled) return
                settled = true
                running--
                resolve(texture)
                pump()
            }
            try {
                shim!.capture_window(addr, maxWidth, maxHeight, null, (_source, result) => {
                    let texture: Gdk.Texture | null = null
                    try {
                        texture = shim!.capture_window_finish(result)
                    } catch (e) {
                        // "window gone or not shareable" is the common, harmless
                        // case (a window closing mid-capture) — but this was on
                        // console.debug, which GJS SUPPRESSES unless G_MESSAGES_DEBUG
                        // is set, so a real failure was invisible. Warn instead: a
                        // handful of lines on a rare event beats a silent feature.
                        console.warn(`[WindowCapture] ${address} failed: ${e}`)
                    }
                    done(texture)
                })
            } catch (e) {
                console.warn(`[WindowCapture] capture_window threw for ${address}: ${e}`)
                done(null)
            }
        })
        pump()
    }).finally(() => {
        inflight.delete(key)
    })

    inflight.set(key, promise)
    return promise
}

/** True once the shim has loaded AND the compositor supports capture. */
export function isCaptureAvailable(): boolean {
    return shim !== null
}

/** Starts loading the shim without capturing anything, so the first open is not
 *  paying for the dynamic import on top of the captures. */
export function warmUp(): void {
    if (!loading) void load()
}
