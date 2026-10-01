import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type Gtk from "gi://Gtk?version=4.0"
import Theme from "./ThemeManager"
import { safeDisconnect } from "./signals"
import { glassBlurInForce } from "./GlassBlur"
import { GLASS_TINT } from "../../lib/nidara-kit/platform/tokens"
import { SOLID_GLASS } from "../../lib/nidara-kit/platform/theme-tokens"
import { setMaterialSource, type GlassParams } from "../../lib/nidara-kit/platform/material"

/**
 * The glass a compositor of our own paints for the shell (#684): the source behind
 * `ui/lib/nidara-kit/platform/material.ts`. Where the compositor offers nidara-material-v1
 * (Hyalo), every shell surface's glass is the compositor's — the backdrop blurred, bent at
 * the edge, saturated, a tint that thickens per pixel only where the backdrop is too bright
 * for white text, a rim of light — and the painters keep content and state. Elsewhere this
 * registers a source nobody asks.
 *
 * The shell's skin is dark whatever the mode (2026-09-30), so the tint is the dark one.
 * Reduce transparency makes every pane solid, as it does on Hyprland. The blur is the glass
 * material's (`GlassBlur.ts`).
 *
 * ⚠️ The numbers are the prototype's (#679), not calibrated: #684 tunes them with the owner
 * on screen. For that, a dev install (`~/.config/nidara/.dev`) reads
 * `~/.config/nidara/glass-tuning.conf` — `key = value` lines, applied as the file is saved:
 *   alphaMin alphaMax target refraction rim saturation   the glass (see GlassParams)
 *   blur = SIZE:PASSES                                   every surface's blur
 *   glass = off                                          blur only: the shell paints its own
 *                                                        glass, as on Hyprland (A/B)
 */

const DEFAULTS = {
    alphaMin: 0.12,       // the least tint, over a dark backdrop
    alphaMax: 0.82,       // the most, over the brightest
    target: 0.2,          // backdrop luminance after tint ≤ this: white text ≥ ~4:1
    refraction: 10,       // logical px of edge displacement
    rim: 0.7,
    saturation: 1.35,
}

type Tuning = Partial<typeof DEFAULTS> & { blur?: { size: number, passes: number }, off?: boolean }
let tuning: Tuning = {}
const listeners = new Set<() => void>()

function params(): GlassParams | null {
    if (tuning.off) return null
    const p = { ...DEFAULTS, ...tuning }
    const t = GLASS_TINT.dark
    if (Theme.reduceTransparency) {
        return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: SOLID_GLASS, alphaMax: SOLID_GLASS,
            target: p.target, refraction: 0, rim: p.rim, saturation: 1 }
    }
    return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: p.alphaMin, alphaMax: p.alphaMax, target: p.target,
        refraction: p.refraction, rim: p.rim, saturation: p.saturation }
}

function parse(text: string): Tuning {
    const out: Tuning = {}
    for (const line of text.split("\n")) {
        const m = line.replace(/#.*/, "").match(/^\s*([A-Za-z]+)\s*=\s*(\S+)\s*$/)
        if (!m) continue
        const [, k, v] = m
        if (k === "blur") {
            const [size, passes] = v.split(":").map(Number)
            if (Number.isFinite(size) && Number.isInteger(passes)) out.blur = { size, passes }
        } else if (k === "glass") {
            out.off = v === "off"
        } else if (k in DEFAULTS && Number.isFinite(Number(v))) {
            (out as Record<string, number>)[k] = Number(v)
        }
    }
    return out
}

let monitor: Gio.FileMonitor | null = null   // held for the shell's lifetime

function watchTuning() {
    const config = `${GLib.get_home_dir()}/.config/nidara`
    if (!GLib.file_test(`${config}/.dev`, GLib.FileTest.EXISTS)) return
    const file = Gio.File.new_for_path(`${config}/glass-tuning.conf`)
    const reload = () => {
        let text = ""
        try {
            const [ok, bytes] = file.load_contents(null)
            if (ok) text = new TextDecoder().decode(bytes)
        } catch { /* no file: the defaults */ }
        tuning = parse(text)
        console.log(`[CompositorGlass] tuning: ${JSON.stringify(tuning)}`)
        for (const cb of listeners) cb()
    }
    monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_m, _f, _o, ev) => {
        if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.DELETED) reload()
    })
    if (file.query_exists(null)) reload()
}

/** Called once from core/AppearanceSync.ts, beside the blur. */
export function initCompositorGlass() {
    watchTuning()
    setMaterialSource({
        glass: (_native: Gtk.Native) => params(),
        blur: (_native: Gtk.Native) => tuning.blur ?? glassBlurInForce(),
        onChange: (cb) => {
            const id = Theme.connect("changed", cb)
            listeners.add(cb)
            return () => { safeDisconnect(Theme, id); listeners.delete(cb) }
        },
    })
}
