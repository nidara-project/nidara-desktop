import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Theme from "./ThemeManager"
import { safeDisconnect } from "./signals"
import { glassBlurInForce } from "./GlassBlur"
import { GLASS_TINT } from "../../lib/nidara-kit/platform/tokens"
import { SOLID_GLASS } from "../../lib/nidara-kit/platform/theme-tokens"
import { GLASS_ADAPT_CEILING, LEGIBILITY_TARGET } from "../../lib/nidara-kit/platform/glass-legibility"
import { setMaterialSource, type GlassParams, type InkParams } from "../../lib/nidara-kit/platform/material"

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
 * The tint's rule is the adaptive glass's on Hyprland, held by the same two numbers: primary
 * text at 4.5:1, and no thicker than its ceiling. Over pure white that is the tint at ≈0.59.
 *
 * ⚠️ The other numbers are the prototype's (#679), not calibrated: #684 tunes them with the owner
 * on screen. For that, a dev install (`~/.config/nidara/.dev`) reads
 * `~/.config/nidara/glass-tuning.conf` — `key = value` lines, applied as the file is saved:
 *   alphaMin alphaMax target refraction lensing rim saturation   the glass (see GlassParams)
 *   inkDarkAbove inkLightBelow                           the ink's thresholds (see below)
 *   blur = SIZE:PASSES                                   every surface's blur
 *   popoverBlur = SIZE:PASSES                            tooltips' and menus' (default: one
 *                                                        pass more than the panels', owner
 *                                                        2026-10-01: more blur than panels)
 *   glass = off                                          blur only: the shell paints its own
 *                                                        glass, as on Hyprland (A/B)
 *   ink = off                                            the text stays white everywhere
 *
 * The ink (owner, 2026-10-01, #684): the shell's text on Hyalo's glass is white and turns
 * dark only where even the DARKEST point under it is brighter than `inkDarkAbove` (WCAG
 * luminance, the glass's own treatment of the backdrop: blurred, saturated, before its
 * tint); it turns back only below `inkLightBelow`. Hyalo measures, per pane of glass; the
 * pane then wears the light skin's tokens (`INK_DARK_CLASS`) and Hyalo lays a light veil
 * under it instead of darkening. ⚠️ Both thresholds are a starting point, to be calibrated
 * with the owner on screen.
 */

const DEFAULTS = {
    alphaMin: 0.12,       // the least tint, over a dark backdrop
    alphaMax: GLASS_ADAPT_CEILING,   // the most, over the brightest
    // The backdrop's WCAG luminance (linear) after tint ≤ this: white text at 4.5:1.
    target: 1.05 / LEGIBILITY_TARGET.primary - 0.05,
    refraction: 10,       // logical px of edge displacement: every shape's least
    // A fraction of the shape's shorter side, where that is more: a large pane lenses more
    // than a small control (2026-10-02). 0.15, measured nested: the bar's capsules (28 px)
    // keep 10, a CC tile (76) bends 11, the dock (92) 14, the media card (172) 26.
    lensing: 0.15,
    rim: 0.7,
    saturation: 1.35,
    // ≈ #e7e7e7 at the darkest point under the text: only a white page or window turns it.
    inkDarkAbove: 0.80,
    // ≈ #d3d3d3: the gap is the hysteresis, so a backdrop on the line does not flicker.
    inkLightBelow: 0.65,
}

type Blur = { size: number, passes: number }
type Tuning = Partial<typeof DEFAULTS> & { blur?: Blur, popoverBlur?: Blur, off?: boolean, inkOff?: boolean }
let tuning: Tuning = {}
const listeners = new Set<() => void>()

function params(): GlassParams | null {
    if (tuning.off) return null
    const p = { ...DEFAULTS, ...tuning }
    const t = GLASS_TINT.dark
    if (Theme.reduceTransparency) {
        return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: SOLID_GLASS, alphaMax: SOLID_GLASS,
            target: p.target, refraction: 0, lensing: 0, rim: p.rim, saturation: 1 }
    }
    return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: p.alphaMin, alphaMax: p.alphaMax, target: p.target,
        refraction: p.refraction, lensing: p.lensing, rim: p.rim, saturation: p.saturation }
}

function inkParams(): InkParams | null {
    if (tuning.off || tuning.inkOff || Theme.reduceTransparency) return null
    const p = { ...DEFAULTS, ...tuning }
    const t = GLASS_TINT.light
    return { darkAbove: p.inkDarkAbove, lightBelow: p.inkLightBelow, tint: { r: t.r, g: t.g, b: t.b } }
}

function parse(text: string): Tuning {
    const out: Tuning = {}
    for (const line of text.split("\n")) {
        const m = line.replace(/#.*/, "").match(/^\s*([A-Za-z]+)\s*=\s*(\S+)\s*$/)
        if (!m) continue
        const [, k, v] = m
        if (k === "blur" || k === "popoverBlur") {
            const [size, passes] = v.split(":").map(Number)
            if (Number.isFinite(size) && Number.isInteger(passes)) out[k] = { size, passes }
        } else if (k === "glass") {
            out.off = v === "off"
        } else if (k === "ink") {
            out.inkOff = v === "off"
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
        ink: (_native: Gtk.Native) => inkParams(),
        blur: (native: Gtk.Native) => {
            const panels = tuning.blur ?? glassBlurInForce()
            // A tooltip or a menu is a popover: a surface of its own, blurred more.
            if (!(native instanceof Gtk.Popover)) return panels
            return tuning.popoverBlur ?? { size: panels.size, passes: panels.passes + 1 }
        },
        onChange: (cb) => {
            const id = Theme.connect("changed", cb)
            listeners.add(cb)
            return () => { safeDisconnect(Theme, id); listeners.delete(cb) }
        },
    })
}
