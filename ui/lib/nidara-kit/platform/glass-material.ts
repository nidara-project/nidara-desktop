// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import { GLASS_TINT } from "./tokens"
import { SOLID_GLASS } from "./theme-tokens"
import { inkFollowsMode, setMaterialSource, type GlassParams, type GlassPiece, type GlassTone, type InkParams,
    type PaneTone, type VeilParams, type GlassShadow } from "./material"

/**
 * THE glass material (#684, #705 step 0): one material for everything Nidara draws as glass —
 * the shell's panes, the lock screen's card — registered as the source behind `material.ts`
 * by each bundle through `registerGlassMaterial`, which supplies only what is its own (Reduce
 * transparency, the panels' blur, the system mode). Where the compositor offers
 * nidara-material-v1 (Hyalo), every surface's glass is the compositor's — the backdrop
 * blurred, bent at the edge, then each pane's TONE, a rim of light — and the painters keep
 * content and state. Elsewhere this registers a source nobody asks.
 *
 * The TONE (owner, 2026-10-11): not a look made to resemble the reference, its MACHINE. The
 * reference's own glass filter was changed input by input in a process of ours and measured
 * over known backdrops (glass-probe `tweak`): five stages, in this order, each with its law
 * (`GlassTone`, material.ts; the shader is hyalo's glass_final.glsl). Each kind of pane
 * (`GlassPiece`) carries the values the reference gives its pair — read from its filter where
 * the filter could be read (the bar's capsules ↔ the toolbar's glass groups, a control; a menu ↔
 * the real menu, a panel), fitted with this same machine where it could not (the Dock and the
 * Control Center are other processes'). `TONES` says which, number by number. The owner chose
 * the reference's values AS THEY ARE, the large dark panels' ceiling included (over white a
 * dark menu lands at ≈ 0.48: the reference's own).
 *
 * Which face a pane wears: the dark one, unless its surface follows the system mode (the dock,
 * `trackModeGlass`; the bar, `trackModeInk`) and the mode is light — and never the light one
 * under `trackNoInk` (the Control Center keeps its own whatever the mode, owner 2026-10-11).
 * A pane whose content the backdrop turns dark (the ink) takes the light face of its piece.
 *
 * Reduce transparency makes every pane solid: a wash of the skin's own colour. The BLUR of glass
 * the compositor paints is not this file's: it is the glass's own, the reference's as measured,
 * mixed per pane by its size (Hyalo's `BlurMix`, references/hyalo.md → "The blur"). What the
 * bundle says (`blur`, `popoverBlur`) blurs only a surface whose glass the client paints itself
 * (`glass = off`, or a compositor that does not paint it).
 *
 * The glass's other numbers — refraction, lensing, rim, the ink's thresholds — are the
 * owner's, tuned in the glass lab (`scripts/dev/glass-lab/`, 2026-10-05, preset "OK 2", #705)
 * together with the shader's. To tune live, a dev install (`~/.config/nidara/.dev`) reads
 * `~/.config/nidara/glass-tuning.conf` — `key = value` lines, applied as the file is saved:
 *   refraction lensing rim                               the glass (see GlassParams)
 *   PIECE.FACE.STAGE                                     one number of one tone: PIECE control,
 *                                                        panel, controlCenter or dock; FACE dark
 *                                                        or light; STAGE saturation, ceiling,
 *                                                        lift, gain, washR/G/B/A, ambient,
 *                                                        ambientLift, ambientGain
 *   inkDarkAbove inkLightBelow                           the ink's thresholds (see below)
 *   veilStrength veilFalloff veilExponent veilInset      the Control Center's veil (below)
 *   fusion                                               how close two panes of one fusion
 *                                                        group join, logical px (0 = off)
 *   fusionHold                                           0..1: every fusion group held that far
 *                                                        towards one shape (to judge the pulse)
 *   formationHold                                        0..1: every pane held that far formed
 *                                                        (#764: to judge glass materializing)
 *   blur = SIZE:PASSES                                   every surface's blur, where the client
 *                                                        paints the glass (with glass = off)
 *   popoverBlur = SIZE:PASSES                            tooltips' and menus' there (default: one
 *                                                        pass more than the panels', owner
 *                                                        2026-10-01: more blur than panels)
 *   glass = off                                          blur only: the shell paints its own
 *                                                        glass, as on Hyprland (A/B)
 *   ink = off                                            the text stays white everywhere
 *   tone = off                                           every pane's tone neutral (A/B: the
 *                                                        blurred backdrop as it is)
 *   shadow = off                                         no pane casts its shadow (A/B)
 *
 * The ink (owner, 2026-10-01, #684): the shell's text on Hyalo's glass is white and turns
 * dark only where even the DARKEST point under it is brighter than `inkDarkAbove` (WCAG
 * luminance, of the backdrop blurred and saturated, before the rest of its tone); it turns
 * back only below `inkLightBelow`. Hyalo measures, per pane of glass; the pane then wears the
 * light skin's tokens (`INK_DARK_CLASS`) and Hyalo gives it the light face of its tone.
 *
 * The Control Center and the Notification Center lie on a FIXED veil the size of the panel
 * (`trackVeilRegion` in Bar.tsx; `veilStrength veilFalloff veilExponent veilInset`, the
 * reference's own, measured 2026-10-11, refitted across its edge 2026-10-12). Nothing else casts anything under its glass.
 */

/** One tone, written as the protocol takes it (`GlassTone`), wash given as a colour and its
 *  opacity. */
function tone(saturation: number, ceiling: number, lift: number, gain: number,
    wash: [number, number, number, number] = [0, 0, 0, 0], ambient = 0, ambientLift = 0, ambientGain = 1): GlassTone {
    return { saturation, ceiling, lift, gain, wash: { r: wash[0], g: wash[1], b: wash[2], a: wash[3] }, ambient,
        ambientLift, ambientGain }
}

/**
 * Each kind of pane's tone, dark and light face. Sources (glass-probe, 2026-10-11):
 *  - control, panel: READ from the reference's filter (catalogue run 38116434211, every glass
 *    layer's inputs): small controls (buttons of every size, the toolbar's groups, a capsule) and
 *    large floating glass (the real menu, a popover, a 220×150 panel) are ONE material — they
 *    share everything but the dark ceiling, and that one follows the pane's SIZE, not its kind
 *    (`darkCeilingFor`: 0.6 up to 64 px of shorter side, 0.35 from 104). The table's ceilings are
 *    the two ends, kept for reading; the size decides. The ambient (its bleed): 0.8 dark, 0.5 light, black 0.125
 *    and white 0.5 dark — the compositor sizes it (none on a control: under 64 px). The light
 *    face's ambient is not modelled (it fits no blend that was tried: ≤ 0.03 on a large pane), so
 *    it carries none. Checked against the same catalogue's PIXELS with this machine: the toolbar's
 *    groups fit to within 0.03, the real menu to within 0.006.
 *  - dock: FITTED to the real Dock over nine greys (run 38104320473): dark within 0.002, light
 *    within 0.001. Saturation is the controls' (unmeasured on it).
 *  - controlCenter: FITTED to the real Control Center's tiles over black, mid grey and white,
 *    behind them the fixed veil (cc_calib, 2026-10-11): exact on those three. Gain 0.794 → 0.809
 *    with the veil refitted (2026-10-12, 0.10 behind them, not 0.078), measured on the real shell
 *    (shell-calib.sh): 0.125 / 0.431 / 0.729 against the reference's 0.125 / 0.430 / 0.729–0.733. One face: the
 *    reference's is the same in both modes, and ours too (owner). Saturation the controls'.
 */
/**
 * The reference's dark ceiling for a pane whose shorter side is `side` logical px: 0.6 up to 64,
 * 0.35 from 104, linearly between — read back from its own filter at 64, 72, 80 … 112 pt, exact at
 * every step (glass-probe `tweak-tone`, run 38180489443). A shorter ramp than its blur's, shadow's
 * and bleed's (64 → 160, Hyalo's `ToneGl::grown`). Only the dark face: the light one is 0.94 at
 * every size.
 */
export function darkCeilingFor(side: number): number {
    const t = Math.min(Math.max((side - 64) / 40, 0), 1)
    return 0.6 + (0.35 - 0.6) * t
}

/** The pieces that are the reference's one material, whose dark ceiling follows the size. */
const SIZED: ReadonlySet<GlassPiece> = new Set<GlassPiece>(["control", "panel"])

const TONES: Record<GlassPiece, { dark: GlassTone, light: GlassTone }> = {
    control: {
        dark: tone(1.3, 0.6, 0.125, 1.125, [0, 0, 0, 0], 0.8, 0.125, 0.5),
        light: tone(1.2, 0.94, 0.4, 1.03, [1, 1, 1, 0.2]),
    },
    panel: {
        dark: tone(1.3, 0.35, 0.125, 1.125, [0, 0, 0, 0], 0.8, 0.125, 0.5),
        light: tone(1.2, 0.94, 0.4, 1.03, [1, 1, 1, 0.2]),
    },
    dock: {
        dark: tone(1.3, 0.745, 0.048, 0.908),
        light: tone(1.2, 1, 0.15, 0.899),
    },
    controlCenter: {
        dark: tone(1.3, 0.985, 0.125, 0.809),
        light: tone(1.3, 0.985, 0.125, 0.809),
    },
}

/**
 * The shadow each kind of pane casts outside its glass, dark and light face. Source: glass-probe
 * `refraction-sizes` (run 38201914917, 2026-10-12): the reference's glass at rest, 80…400 pt, over
 * a 0.9 grey, the darkening outside it read as a black layer on the sRGB value and fitted to a
 * blurred rounded rectangle moved down — within 0.0012 at every size (`tools/shadow_fit.py`).
 * The offset is 8 at every size; opacity and deviation grow from 80 to 160 and then hold, the
 * ramp of the blur and the ambient: opacity 0.013 → 0.175 dark, 0.013 → 0.115 light (the fit at
 * 80, 120 and 160 lies on those lines), deviation 2 → 17 (4.5 / 11 / 17 measured). There IS a
 * shadow at rest: the 2026-10-08 runs that said none had their window inactive.
 * Measured on the reference's floating glass, which is what `control` and `panel` are; the Dock
 * and the Control Center were not measured, so they cast none.
 */
const SHADOWS: Partial<Record<GlassPiece, { dark: GlassShadow, light: GlassShadow }>> = {
    control: {
        dark: { opacitySmall: 0.013, opacityLarge: 0.175, blurSmall: 2, blurLarge: 17, offset: 8 },
        light: { opacitySmall: 0.013, opacityLarge: 0.115, blurSmall: 2, blurLarge: 17, offset: 8 },
    },
    panel: {
        dark: { opacitySmall: 0.013, opacityLarge: 0.175, blurSmall: 2, blurLarge: 17, offset: 8 },
        light: { opacitySmall: 0.013, opacityLarge: 0.115, blurSmall: 2, blurLarge: 17, offset: 8 },
    },
}

/** The tones as the material ships them (a dev instrument starts from them; nothing else
 *  should need them). */
export const GLASS_TONES: Readonly<typeof TONES> = TONES

/** The tone stages `glass-tuning.conf` names (`PIECE.FACE.STAGE`). */
export const TONE_STAGES = ["saturation", "ceiling", "lift", "gain", "washR", "washG", "washB", "washA", "ambient",
    "ambientLift", "ambientGain"] as const

/** A stage of a tone, by its `glass-tuning.conf` name. */
export function toneStage(t: GlassTone, stage: typeof TONE_STAGES[number]): number {
    switch (stage) {
        case "washR": return t.wash.r
        case "washG": return t.wash.g
        case "washB": return t.wash.b
        case "washA": return t.wash.a
        default: return t[stage]
    }
}

const NEUTRAL_TONE = tone(1, 1, 0, 1)

const DEFAULTS = {
    // Logical px, every shape's least: what sets the bevel's width (≈4.3× this, hyalo's
    // glass_gl.rs), held to half the shape's shorter side and to 80 px (`BEVEL_MAX`). At 40 the
    // bevel is as wide as it may be on every shape: a bar capsule is lens all across, a large
    // pane bends over its outer 80 px and is flat inside. The shader's profile (5th power) and
    // strength (×3) do the rest.
    refraction: 40,
    // A fraction of the shape's shorter side, where that is more than `refraction`: a large
    // pane lenses more than a small control — up to `BEVEL_MAX`. 0.15 turned the app grid into
    // one magnifier on 2026-10-02 and was dropped to 0.03; the cap made it safe again (the lab,
    // 2026-10-05).
    lensing: 0.15,
    rim: 0.5,
    // The darkest point under the text, as the glass treats the backdrop: past this the text
    // turns dark. 0.35 (the lab, 2026-10-05; 0.80 before): a page of text behind the glass —
    // always black letters under it — turns it too, and the pane reads as clear glass with
    // dark text over the blurred page instead of a grey slab with white text on it.
    inkDarkAbove: 0.35,
    // The gap is the hysteresis, so a backdrop on the line does not flicker.
    inkLightBelow: 0.25,
    // The VEIL the Control Center and the Notification Center lie on (`trackVeilRegion` in
    // Bar.tsx). The reference's, measured on its own Control Center over known wallpapers
    // (glass-probe, runs 38119286883/38119289287, the same in both modes), read across its edge
    // from deep in a gap between tiles to 140 px outside: 0.10 between the tiles, falling in a
    // straight line from 34 px INSIDE the box of the tiles over 155 px — 0.082 at its edge,
    // 0.055 at 40 px, 0.024 at 80, 0.008 at 117 (fitted within 0.006 everywhere, 2026-10-12).
    // Until then 0.078, flat to 40 px OUTSIDE the box, as (1 − d/125)^1.5: the median of the
    // whole region, its fall measured from the wrong edge — 0.016 rms off, 6× this. Fixed: the
    // backdrop does not change it.
    veilStrength: 0.10,
    veilFalloff: 155,
    veilExponent: 1,
    veilInset: 34,
    // Fusion (#705 step 2, `trackFusionGroup`): two panes of one group closer than this many
    // logical px are joined by a bridge, one silhouette. The island's chips' glass sits 8 px from
    // its capsule's (their boxes 4, the glass inset 2 a side): at 8 they were joined at rest by a thin neck whose rims nearly met (owner,
    // 2026-10-06: "they look as if they tend to touch"); at 2 each one is its own pane at rest
    // ("the separation is perfect") and they still fuse as they come together. While the group
    // changes it becomes one shape (`pulseFusion`), which is not a spacing. 0: off.
    fusion: 2,
    // An instrument, 0 in the product: every fusion group held this far towards its envelope
    // (`pulseFusion` passes in 350 ms; held, the shape can be judged — and screenshotted).
    fusionHold: 0,
    // An instrument, 0 in the product: every pane held this far formed (#764 — a pane appears by
    // materializing: its blur, refraction, tint and rim grow; held, a step of it can be judged).
    formationHold: 0,
}

/** The material's numbers as it ships them — what `glass-tuning.conf` overrides (a dev
 *  instrument shows them; nothing else should need them). */
export const GLASS_MATERIAL_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS

type Blur = { size: number, passes: number }
type ToneTuning = Partial<Record<`${GlassPiece}.${"dark" | "light"}.${string}`, number>>
type Tuning = Partial<typeof DEFAULTS> & { blur?: Blur, popoverBlur?: Blur, off?: boolean, inkOff?: boolean, toneOff?: boolean,
    shadowOff?: boolean, tones?: ToneTuning }
let tuning: Tuning = {}
const listeners = new Set<() => void>()

/** What a bundle supplies; everything else about the glass is the material's. */
export interface GlassMaterialHost {
    /** Settings → Reduce transparency: every pane solid. */
    reduceTransparency(): boolean
    /** The panels' blur (a tooltip or a menu takes one pass more). */
    panelBlur(): Blur
    /** The system mode is light — for a surface whose glass follows it (`trackModeGlass`).
     *  Absent: dark. */
    lightMode?(): boolean
    /** Calls `cb` whenever any of the above may have changed; returns the disconnect. */
    onChange(cb: () => void): () => void
}

let host: GlassMaterialHost | null = null
const reduced = () => host?.reduceTransparency() ?? false

function params(): GlassParams | null {
    if (tuning.off) return null
    const p = { ...DEFAULTS, ...tuning }
    return { refraction: reduced() ? 0 : p.refraction, lensing: reduced() ? 0 : p.lensing, rim: p.rim }
}

/** One face of a piece's tone, with what `glass-tuning.conf` says of it. */
function faceOf(piece: GlassPiece, face: "dark" | "light", side: number | null): GlassTone {
    if (tuning.toneOff) return NEUTRAL_TONE
    const table = TONES[piece][face]
    const base = side !== null && face === "dark" && SIZED.has(piece) ? { ...table, ceiling: darkCeilingFor(side) } : table
    if (reduced()) {
        // Solid: the skin's own colour over everything.
        const c = face === "dark" ? GLASS_TINT.dark : GLASS_TINT.light
        return { ...NEUTRAL_TONE, wash: { r: c.r, g: c.g, b: c.b, a: SOLID_GLASS } }
    }
    const t = tuning.tones
    if (!t) return base
    const get = (stage: typeof TONE_STAGES[number], v: number) => t[`${piece}.${face}.${stage}`] ?? v
    return {
        saturation: get("saturation", base.saturation), ceiling: get("ceiling", base.ceiling),
        lift: get("lift", base.lift), gain: get("gain", base.gain),
        wash: { r: get("washR", base.wash.r), g: get("washG", base.wash.g), b: get("washB", base.wash.b),
            a: get("washA", base.wash.a) },
        ambient: get("ambient", base.ambient), ambientLift: get("ambientLift", base.ambientLift),
        ambientGain: get("ambientGain", base.ambientGain),
    }
}

/** A pane of `piece`: its face by the system mode where its surface follows it, and the light
 *  face while the backdrop turns its content dark. One object per answer, so a surface's panes
 *  of one kind share it (material.ts sends a tone only where it changes). */
const paneTones = new Map<string, PaneTone>()
/** A pane's tone and ink tone; `side` its shorter side, logical px (the dark ceiling follows it). */
function paneTone(piece: GlassPiece, light: boolean, side: number): PaneTone {
    const lightMode = light && (host?.lightMode?.() ?? false)
    // Whole px: a pane growing (a morph) changes its ceiling at most once a pixel.
    const sized = SIZED.has(piece) ? Math.round(side) : null
    const key = `${piece}:${lightMode}:${sized ?? ""}`
    let t = paneTones.get(key)
    if (!t) {
        t = { tone: faceOf(piece, lightMode ? "light" : "dark", sized), inkTone: lightMode ? null : faceOf(piece, "light", sized),
            shadow: tuning.off || tuning.shadowOff ? null : SHADOWS[piece]?.[lightMode ? "light" : "dark"] ?? null }
        paneTones.set(key, t)
    }
    return t
}

function inkParams(native: Gtk.Native | null = null): InkParams | null {
    if (tuning.off || tuning.inkOff || reduced()) return null
    const p = { ...DEFAULTS, ...tuning }
    // An ink that follows the mode (`trackModeInk`): thresholds no backdrop can miss — any
    // luminance (0..1) is above −1, so light mode turns it dark at the first measurement and
    // nothing turns it back (light_below −2); in dark mode nothing turns it dark (2) and
    // anything turns it light (1.5).
    if (native && inkFollowsMode(native)) {
        const light = host?.lightMode?.() ?? false
        return { darkAbove: light ? -1 : 2, lightBelow: light ? -2 : 1.5 }
    }
    return { darkAbove: p.inkDarkAbove, lightBelow: p.inkLightBelow }
}

function veilParams(): VeilParams | null {
    if (tuning.off || reduced()) return null
    const p = { ...DEFAULTS, ...tuning }
    return { strength: p.veilStrength, falloff: p.veilFalloff, exponent: p.veilExponent, inset: p.veilInset }
}

function parse(text: string): Tuning {
    const out: Tuning = {}
    for (const line of text.split("\n")) {
        const m = line.replace(/#.*/, "").match(/^\s*([A-Za-z.]+)\s*=\s*(\S+)\s*$/)
        if (!m) continue
        const [, k, v] = m
        const [piece, face, stage] = k.split(".")
        if (stage !== undefined) {
            if (piece in TONES && (face === "dark" || face === "light")
                && (TONE_STAGES as readonly string[]).includes(stage) && Number.isFinite(Number(v)))
                out.tones = { ...out.tones, [k]: Number(v) }
        } else if (k === "blur" || k === "popoverBlur") {
            const [size, passes] = v.split(":").map(Number)
            if (Number.isFinite(size) && Number.isInteger(passes)) out[k] = { size, passes }
        } else if (k === "glass") {
            out.off = v === "off"
        } else if (k === "ink") {
            out.inkOff = v === "off"
        } else if (k === "tone") {
            out.toneOff = v === "off"
        } else if (k === "shadow") {
            out.shadowOff = v === "off"
        } else if (k in DEFAULTS && Number.isFinite(Number(v))) {
            (out as Record<string, number>)[k] = Number(v)
        }
    }
    return out
}

let monitor: Gio.FileMonitor | null = null   // held for the process's lifetime

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
        paneTones.clear()
        console.log(`[glass-material] tuning: ${JSON.stringify(tuning)}`)
        for (const cb of listeners) cb()
    }
    monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_m, _f, _o, ev) => {
        if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.DELETED) reload()
    })
    if (file.query_exists(null)) reload()
}

/** Registers the glass material as this bundle's material source. Called once, from its app. */
export function registerGlassMaterial(h: GlassMaterialHost) {
    host = h
    watchTuning()
    setMaterialSource({
        glass: (_native: Gtk.Native) => params(),
        ink: (native: Gtk.Native) => inkParams(native),
        tone: (_native: Gtk.Native, piece: GlassPiece, light: boolean, side: number) => paneTone(piece, light, side),
        veil: (_native: Gtk.Native) => veilParams(),
        fusion: (_native: Gtk.Native) => tuning.off ? null : (tuning.fusion ?? DEFAULTS.fusion),
        fusionHold: (_native: Gtk.Native) => tuning.fusionHold ?? DEFAULTS.fusionHold,
        formationHold: (_native: Gtk.Native) => tuning.formationHold ?? DEFAULTS.formationHold,
        blur: (native: Gtk.Native) => {
            const panels = tuning.blur ?? h.panelBlur()
            // A tooltip or a menu is a popover: a surface of its own, blurred more.
            if (!(native instanceof Gtk.Popover)) return panels
            return tuning.popoverBlur ?? { size: panels.size, passes: panels.passes + 1 }
        },
        onChange: (cb) => {
            // The mode or Reduce transparency may have changed: every tone is asked again.
            const off = h.onChange(() => { paneTones.clear(); cb() })
            listeners.add(cb)
            return () => { off(); listeners.delete(cb) }
        },
    })
}
