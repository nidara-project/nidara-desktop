// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import { GLASS_TINT } from "./tokens"
import { SOLID_GLASS } from "./theme-tokens"
import { GLASS_ADAPT_CEILING, LEGIBILITY_TARGET } from "./glass-legibility"
import { setMaterialSource, type GlassParams, type InkParams, type ScrimParams } from "./material"

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
 * The shell's skin is dark whatever the mode (2026-09-30), so the tint is the dark one.
 * Reduce transparency makes every pane solid, as it does on Hyprland. The panels' blur is the
 * bundle's to say (the shell's follows Settings' glass material, `GlassBlur.ts`).
 *
 * The tint's rule is the adaptive glass's on Hyprland, held by the same two numbers: primary
 * text at 4.5:1, and no thicker than its ceiling. Over pure white that is the tint at ≈0.59.
 *
 * The glass's own numbers — refraction, lensing, rim, saturation, the least tint, the ink's
 * thresholds — are the owner's, tuned in the glass lab (`scripts/dev/glass-lab/`, 2026-10-05,
 * preset "OK 2", #705) together with the shader's (hyalo's `glass_gl.rs`). The shadow's are
 * still those of 2026-10-02: how the shadow applies is undecided (#705). To tune live, a dev install (`~/.config/nidara/.dev`) reads
 * `~/.config/nidara/glass-tuning.conf` — `key = value` lines, applied as the file is saved:
 *   alphaMin alphaMax target refraction lensing rim saturation   the glass (see GlassParams)
 *   inkDarkAbove inkLightBelow                           the ink's thresholds (see below)
 *   tintLimit scrimMax scrimSize scrimFalloff scrimEdge  the shadow under the glass (below)
 *   fusion                                               how close two panes of one fusion
 *                                                        group join, logical px (0 = off)
 *   fusionPulse                                          the spacing a group reaches while it
 *                                                        changes (the island's swaps)
 *   blur = SIZE:PASSES                                   every surface's blur
 *   popoverBlur = SIZE:PASSES                            tooltips' and menus' (default: one
 *                                                        pass more than the panels', owner
 *                                                        2026-10-01: more blur than panels)
 *   glass = off                                          blur only: the shell paints its own
 *                                                        glass, as on Hyprland (A/B)
 *   ink = off                                            the text stays white everywhere
 *   scrim = off                                          no shadow under the glass (A/B)
 *
 * The ink (owner, 2026-10-01, #684): the shell's text on Hyalo's glass is white and turns
 * dark only where even the DARKEST point under it is brighter than `inkDarkAbove` (WCAG
 * luminance, the glass's own treatment of the backdrop: blurred, saturated, before its
 * tint); it turns back only below `inkLightBelow`. Hyalo measures, per pane of glass; the
 * pane then wears the light skin's tokens (`INK_DARK_CLASS`) and Hyalo lays a light veil
 * under it instead of darkening. ⚠️ Both thresholds are a starting point, to be calibrated
 * with the owner on screen.
 *
 * The shadow under the glass (owner, 2026-10-02, #684): with the tint alone, a pane over a
 * backdrop bright in one place and dark in another came out grey in one part and clear in the
 * other — the tint thickens per pixel — and over a bright one the whole pane looked painted
 * grey. "The limit has to be in the glass": the glass takes no more tint than `tintLimit`, and
 * Hyalo lays a soft shadow UNDER it, even across the pane, with exactly what the glass is
 * missing for the text to be legible at the brightest point — none where the glass reaches it
 * alone, none under a pane whose text has turned dark (the ink's veil), at most `scrimMax`.
 * The glass's ceiling IS `tintLimit` while there is a shadow: nothing makes up past
 * `scrimMax`, because a tint above the limit is the grey plastic again. A pane's own
 * shadow fades over `scrimSize` of its shorter side (the app grid's, the overview's); the
 * Control Center and the Notification Center share one the size of the panel
 * (`trackScrimRegion` in Bar.tsx), even across the container (`scrimEdge` 1; below 1 it
 * sweeps from the centre), then fading over `scrimFalloff` px. Owner, 2026-10-02: even across the
 * panel "it looks like a translucent dark panel with a gradient at its border", where it
 * should be "very subtle, very slightly darker at the centre, sweeping from the centre, over
 * the container's area". The bar and the dock cast none for now (`trackNoScrim`): a shadow that
 * hugs them cannot fade without running over the windows — an edge shadow drawn by Hyalo,
 * under the windows, is the next step.
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
    // The shadow's opacity at its core, at most. Pure white needs ≈0.41 with the glass at
    // `tintLimit`; past this the text is less legible, not the glass greyer.
    scrimMax: 0.6,
    // A pane's own shadow fades over this fraction of its shorter side (a notification
    // ≈35 px; the app grid, the overview).
    scrimSize: 0.5,
    // The Control Center's shadow fades to nothing over this many px outside its glass. 380
    // with the shadow even across the panel was "totally exaggerated" and 48 a step you could
    // see (owner, 2026-10-02: "it has to end with no jump between the shadow and the
    // backdrop"); with the sweep from the centre a long fade reads as none.
    scrimFalloff: 160,
    // The Control Center's shadow at its edges, as a fraction of its centre's (1: even). Even
    // (owner, 2026-10-02): the shadow is what the glass lacks at the brightest point, so it holds
    // across the whole container and only fades outside it; the sweep (0.7) left the edge tiles
    // short of it and did not read on screen anyway.
    scrimEdge: 1,
    // The most tint the glass takes while the shadow makes up the rest (owner, 2026-10-02):
    // past it a pane looks painted grey. Over white the shadow is then ≈0.41.
    tintLimit: 0.25,
    // Fusion (#705 step 2, `trackFusionGroup`): two panes of one group closer than this many
    // logical px are joined by a bridge, one silhouette. The island's chips sit 4 px from its
    // capsule: at 8 they were joined at rest by a thin neck whose rims nearly met (owner,
    // 2026-10-06: "they look as if they tend to touch"); at 2 each one is its own pane at rest
    // ("the separation is perfect") and they still fuse as they come together. 0: off.
    fusion: 2,
    // The spacing a group reaches for an instant while it changes (`pulseFusion`: the island
    // swapping what its capsule and its chips show), there and back over the change — the
    // panes join by a bridge while their content trades places, and part again at rest.
    // 18: the island's pieces are 36 px tall and 4 px apart, so at the pulse's height the
    // bridge is as tall as they are — one capsule for an instant — without bulging past
    // their edges (owner, 2026-10-07: "the bridge should get to form one single capsule").
    fusionPulse: 18,
}

/** The material's numbers as it ships them — what `glass-tuning.conf` overrides (a dev
 *  instrument shows them; nothing else should need them). */
export const GLASS_MATERIAL_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS

type Blur = { size: number, passes: number }
type Tuning = Partial<typeof DEFAULTS> & { blur?: Blur, popoverBlur?: Blur, off?: boolean, inkOff?: boolean, scrimOff?: boolean }
let tuning: Tuning = {}
const listeners = new Set<() => void>()

/** What a bundle supplies; everything else about the glass is the material's. */
export interface GlassMaterialHost {
    /** Settings → Reduce transparency: every pane solid. */
    reduceTransparency(): boolean
    /** The panels' blur (a tooltip or a menu takes one pass more). */
    panelBlur(): Blur
    /** Calls `cb` whenever either of the two above may have changed; returns the disconnect. */
    onChange(cb: () => void): () => void
}

let host: GlassMaterialHost | null = null
const reduced = () => host?.reduceTransparency() ?? false

function params(): GlassParams | null {
    if (tuning.off) return null
    const p = { ...DEFAULTS, ...tuning }
    const t = GLASS_TINT.dark
    if (reduced()) {
        return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: SOLID_GLASS, alphaMax: SOLID_GLASS,
            target: p.target, refraction: 0, lensing: 0, rim: p.rim, saturation: 1 }
    }
    // With the shadow under it, the glass never darkens past `tintLimit` — not even to keep the
    // text legible, which is the shadow's job (owner, 2026-10-02: a ceiling above it "makes the
    // grey plastic again"). Without the shadow (the A/B), `alphaMax` as before.
    const alphaMax = tuning.scrimOff ? p.alphaMax : Math.min(p.alphaMax, p.tintLimit)
    return { tint: { r: t.r, g: t.g, b: t.b }, alphaMin: p.alphaMin, alphaMax, target: p.target,
        refraction: p.refraction, lensing: p.lensing, rim: p.rim, saturation: p.saturation }
}

function inkParams(): InkParams | null {
    if (tuning.off || tuning.inkOff || reduced()) return null
    const p = { ...DEFAULTS, ...tuning }
    const t = GLASS_TINT.light
    return { darkAbove: p.inkDarkAbove, lightBelow: p.inkLightBelow, tint: { r: t.r, g: t.g, b: t.b } }
}

function scrimParams(): ScrimParams | null {
    if (tuning.off || tuning.scrimOff || reduced()) return null
    const p = { ...DEFAULTS, ...tuning }
    return { maxStrength: p.scrimMax, sizeFraction: p.scrimSize, regionFalloff: p.scrimFalloff, tintLimit: p.tintLimit,
        regionEdge: p.scrimEdge }
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
        } else if (k === "scrim") {
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
        glass: (_native: Gtk.Native) => params(),
        ink: (_native: Gtk.Native) => inkParams(),
        scrim: (_native: Gtk.Native) => scrimParams(),
        fusion: (_native: Gtk.Native) => tuning.off ? null : (tuning.fusion ?? DEFAULTS.fusion),
        fusionPulse: (_native: Gtk.Native) => tuning.off ? null : (tuning.fusionPulse ?? DEFAULTS.fusionPulse),
        blur: (native: Gtk.Native) => {
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
