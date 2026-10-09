// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import { GLASS_TINT } from "./tokens"
import { SOLID_GLASS } from "./theme-tokens"
import { GLASS_ADAPT_CEILING, LEGIBILITY_TARGET } from "./glass-legibility"
import { fluidCrystalFor, glassFollowsMode, glassIsDense, inkFollowsMode, setMaterialSource, type GlassParams, type InkParams, type ScrimParams } from "./material"

/**
 * THE glass material (#684, #705 step 0): one material for everything Nidara draws as glass —
 * the shell's panes, the lock screen's card — registered as the source behind `material.ts`
 * by each bundle through `registerGlassMaterial`, which supplies only what is its own (Reduce
 * transparency, the panels' blur). Where the compositor offers nidara-material-v1
 * (Hyalo), every surface's glass is the compositor's — the backdrop blurred, bent at
 * the edge, saturated, a tint that thickens per pixel only where the backdrop is too bright
 * for white text, a rim of light — and the painters keep content and state. Elsewhere this
 * registers a source nobody asks.
 *
 * Regular follows the system appearance when the surface's profile asks for mode content:
 * light mode uses the light veil and dark content, dark mode uses the dark adaptive crystal and
 * light content. Clear stays independent of the mode with light content. Reduce transparency
 * makes every pane solid, as it does on Hyprland. The panels' blur is the bundle's to say.
 *
 * The tint's rule is the adaptive glass's on Hyprland, held by the same two numbers: primary
 * text at 4.5:1, and no thicker than its ceiling. Over pure white that is the tint at ≈0.59.
 *
 * The glass's own numbers — refraction, lensing, rim, saturation, the least tint, the ink's
 * thresholds — are the owner's, tuned in the glass lab (`scripts/dev/glass-lab/`, 2026-10-05,
 * preset "OK 2", #705) together with the shader's (hyalo's `glass_gl.rs`). To tune live, a dev
 * install (`~/.config/nidara/.dev`) reads
 * `~/.config/nidara/glass-tuning.conf` — `key = value` lines, applied as the file is saved:
 *   alphaMin alphaMax target refraction lensing rim saturation   the glass (see GlassParams)
 *   inkDarkAbove inkLightBelow                           the ink's thresholds (see below)
 *   tintLimit                                              regular crystal's tint ceiling
 *   modeLightVeil                                        the light glass of a surface that
 *                                                        follows the mode (the dock), light mode
 *   fusion                                               how close two panes of one fusion
 *                                                        group join, logical px (0 = off)
 *   fusionHold                                           0..1: every fusion group held that far
 *                                                        towards one shape (to judge the pulse)
 *   formationHold                                        0..1: every pane held that far formed
 *                                                        (#764: to judge glass materializing)
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
 *
 * A global scrim under the glass is intentionally disabled while Fluid Crystal is being
 * established. It made large translucent surfaces read as grey panels and coupled legibility
 * to a second, hard-to-tune layer. Component elevation remains available for individual tiles
 * and panels; it is a separate effect, outside this material's base recipe.
 */

const DEFAULTS = {
    // The least tint, over a dark backdrop: none — the glass darkens only where the backdrop is
    // too bright for white text (the lab, 2026-10-05; 0.12 before).
    alphaMin: 0,
    alphaMax: GLASS_ADAPT_CEILING,   // the most, over the brightest
    // The backdrop's WCAG luminance (linear) after tint ≤ this: white text at 4.5:1.
    target: 1.05 / LEGIBILITY_TARGET.primary - 0.05,
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
    saturation: 1.25,
    // The darkest point under the text, as the glass treats the backdrop: past this the text
    // turns dark. 0.35 (the lab, 2026-10-05; 0.80 before): a page of text behind the glass —
    // always black letters under it — turns it too, and the pane reads as clear glass with
    // dark text over the blurred page instead of a grey slab with white text on it.
    inkDarkAbove: 0.35,
    // The gap is the hysteresis, so a backdrop on the line does not flicker.
    inkLightBelow: 0.25,
    // Legacy scrim knobs are retained so older tuning files remain readable. The global scrim is
    // currently disabled; component elevation is tuned separately by the owning surface.
    scrimMax: 0.6,
    scrimSize: 0.5,
    scrimFalloff: 160,
    scrimEdge: 1,
    // The maximum opacity regular crystal takes over bright backdrops. Keeping this independent
    // from the scrim lets the Lab tune translucency directly.
    tintLimit: 0.25,
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
    // Legacy light-mode veil knob; Regular light now owns the same starting value in its variant
    // defaults, while this remains readable for older tuning files.
    modeLightVeil: 0.2,
}

/** The light Regular variant: a mode-coloured veil with mode-coloured content. */
const REGULAR_LIGHT_DEFAULTS: Readonly<typeof DEFAULTS> = {
    ...DEFAULTS,
    alphaMin: 0.2,
    alphaMax: 0.2,
    target: 1,
}

/** The Clear variant: transparent by default, with a fixed light foreground over media. */
const CLEAR_DEFAULTS: Readonly<typeof DEFAULTS> = {
    ...DEFAULTS,
    alphaMin: 0,
    alphaMax: 0.25,
}

/** The dense profiles' starting values, tuned independently in the Glass Lab. */
const DENSE_DEFAULTS: Partial<typeof DEFAULTS> = {
    alphaMin: 0.9,
    alphaMax: 0.9,
    target: 1,
}

/** The material's numbers as it ships them — what `glass-tuning.conf` overrides (a dev
 *  instrument shows them; nothing else should need them). */
export const GLASS_MATERIAL_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS
/** The light Regular variant's defaults, exposed to the Glass Lab. */
export const GLASS_REGULAR_LIGHT_DEFAULTS: Readonly<typeof DEFAULTS> = REGULAR_LIGHT_DEFAULTS
/** The Clear variant's defaults, exposed to the Glass Lab. */
export const GLASS_CLEAR_DEFAULTS: Readonly<typeof DEFAULTS> = CLEAR_DEFAULTS
/** Kept for older Lab presets; density is now a profile, not a crystal variant. */
export const GLASS_DENSE_DEFAULTS: Readonly<typeof DEFAULTS> = { ...DEFAULTS, ...DENSE_DEFAULTS }

type Blur = { size: number, passes: number }
type TypeTuning = Partial<typeof DEFAULTS> & { blur?: Blur }
type Tuning = TypeTuning & {
    popoverBlur?: Blur, off?: boolean, inkOff?: boolean, scrimOff?: boolean,
    regularLight?: TypeTuning, regularDark?: TypeTuning, clear?: TypeTuning, dense?: TypeTuning
}
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

type MaterialVariant = "regularLight" | "regularDark" | "clear"

function materialFor(native: Gtk.Native | null): { variant: MaterialVariant, spec: ReturnType<typeof fluidCrystalFor>, p: typeof DEFAULTS, dense: boolean } {
    const spec = native ? fluidCrystalFor(native) : null
    const followsMode = !!native && (spec?.ink === "mode" || glassFollowsMode(native))
    const variant: MaterialVariant = spec?.variant === "clear"
        ? "clear"
        : followsMode && host?.lightMode?.() ? "regularLight" : "regularDark"
    const profileIsDense = spec?.variant === "regular" && (spec.profile === "launcher" || spec.profile === "popover")
    const legacyIsDense = !!native && glassIsDense(native)
    const defaults = variant === "regularLight" ? REGULAR_LIGHT_DEFAULTS : variant === "clear" ? CLEAR_DEFAULTS : DEFAULTS
    const selected = tuning[variant] ?? {}
    const p = { ...DEFAULTS, ...tuning, ...defaults,
        ...(profileIsDense || legacyIsDense ? DENSE_DEFAULTS : {}), ...selected }
    return { variant, spec, p, dense: profileIsDense || legacyIsDense }
}

function params(native: Gtk.Native | null = null): GlassParams | null {
    if (tuning.off) return null
    const { variant, p, dense } = materialFor(native)
    // Regular light is a mode-coloured veil and does not adapt its alpha to white text: its
    // content is dark in this variant. Dense profiles keep their own alpha values here.
    if (variant === "regularLight") {
        const l = GLASS_TINT.light
        return { tint: { r: l.r, g: l.g, b: l.b },
            alphaMin: reduced() ? SOLID_GLASS : p.alphaMin, alphaMax: reduced() ? SOLID_GLASS : p.alphaMax, target: p.target,
            refraction: reduced() ? 0 : p.refraction, lensing: reduced() ? 0 : p.lensing, rim: p.rim,
            saturation: reduced() ? 1 : p.saturation }
    }
    const t = GLASS_TINT.dark
    if (reduced()) {
        return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: SOLID_GLASS, alphaMax: SOLID_GLASS,
            target: p.target, refraction: 0, lensing: 0, rim: p.rim, saturation: 1 }
    }
    // Clear and Regular dark keep their tint ceiling in the material; no global scrim makes up
    // the difference. Dense profiles intentionally bypass that translucent ceiling.
    const alphaMax = dense ? Math.max(p.alphaMax, p.alphaMin) : Math.min(p.alphaMax, p.tintLimit)
    return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: p.alphaMin, alphaMax, target: p.target,
        refraction: p.refraction, lensing: p.lensing, rim: p.rim, saturation: p.saturation }
}

function inkParams(native: Gtk.Native | null = null): InkParams | null {
    if (tuning.off || tuning.inkOff || reduced()) return null
    const { variant, spec, p } = materialFor(native)
    const t = GLASS_TINT.light
    if (variant === "clear" || spec?.ink === "light")
        return { darkAbove: 2, lightBelow: 1.5, tint: { r: t.r, g: t.g, b: t.b } }
    // An ink that follows the mode (`trackModeInk`): thresholds no backdrop can miss — any
    // luminance (0..1) is above −1, so light mode turns it dark at the first measurement and
    // nothing turns it back (light_below −2); in dark mode nothing turns it dark (2) and
    // anything turns it light (1.5).
    if (native && (spec?.ink === "mode" || inkFollowsMode(native))) {
        const light = variant === "regularLight"
        return { darkAbove: light ? -1 : 2, lightBelow: light ? -2 : 1.5, tint: { r: t.r, g: t.g, b: t.b } }
    }
    return { darkAbove: p.inkDarkAbove, lightBelow: p.inkLightBelow, tint: { r: t.r, g: t.g, b: t.b } }
}

function scrimParams(): ScrimParams | null {
    // Keep the lower-level Hyalo protocol available for a future component effect, but do not
    // enable a global scrim as part of Fluid Crystal's base recipe.
    return null
}

function parse(text: string): Tuning {
    const out: Tuning = {}
    for (const line of text.split("\n")) {
        const m = line.replace(/#.*/, "").match(/^\s*(?:(regularLight|regularDark|clear|dense)\.)?([A-Za-z]+)\s*=\s*(\S+)\s*$/)
        if (!m) continue
        const [, type, k, v] = m
        const into: TypeTuning = type ? ((out as Record<string, TypeTuning>)[type] ??= {}) : out
        if (k === "blur" || (!type && k === "popoverBlur")) {
            const [size, passes] = v.split(":").map(Number)
            if (Number.isFinite(size) && Number.isInteger(passes)) (into as Tuning)[k as "blur"] = { size, passes }
        } else if (type) {
            if (k in DEFAULTS && Number.isFinite(Number(v))) (into as Record<string, number>)[k] = Number(v)
        } else if (k === "glass") {
            out.off = v === "off"
        } else if (k === "ink") {
            out.inkOff = v === "off"
        } else if (k === "scrim") {
            // Legacy tuning files may still contain this switch; Fluid Crystal no longer paints
            // a global scrim, so the value is accepted only for backwards compatibility.
            out.scrimOff = v === "off"
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
        glass: (native: Gtk.Native) => params(native),
        ink: (native: Gtk.Native) => inkParams(native),
        scrim: (_native: Gtk.Native) => scrimParams(),
        fusion: (_native: Gtk.Native) => tuning.off ? null : (tuning.fusion ?? DEFAULTS.fusion),
        fusionHold: (_native: Gtk.Native) => tuning.fusionHold ?? DEFAULTS.fusionHold,
        formationHold: (_native: Gtk.Native) => tuning.formationHold ?? DEFAULTS.formationHold,
        blur: (native: Gtk.Native) => {
            const { variant } = materialFor(native)
            if (tuning[variant]?.blur) return tuning[variant]!.blur!
            if (tuning.dense?.blur && glassIsDense(native)) return tuning.dense.blur
            const panels = tuning.blur ?? h.panelBlur()
            // A tooltip or a menu is a popover: a surface of its own, blurred more.
            if (!(native instanceof Gtk.Popover)) return panels
            return tuning.popoverBlur ?? { size: panels.size, passes: panels.passes + 1 }
        },
        onChange: (cb) => {
            const off = h.onChange(cb)
            listeners.add(cb)
            return () => { off(); listeners.delete(cb) }
        },
    })
}
