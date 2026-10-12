import Gtk from "gi://Gtk?version=4.0"
import Theme from "../core/ThemeManager"
import { frostedFill, setGlassFrost, type Rgb } from "../../lib/nidara-kit/platform/glass-legibility"
import { GLASS_ROLE_FLOORS } from "../../lib/nidara-kit/platform/theme-tokens"
import { GLASS_TINT } from "../../lib/nidara-kit/platform/tokens"
import { darkInkFor } from "../../lib/nidara-kit/platform/material"

/**
 * What a Cairo painter on the shell's chrome paints with: the skin, the tint and the opacity
 * of the glass it sits in.
 *
 * A surface (the bar, a panel, the island, the app grid, the dock) is REGISTERED here with its
 * root widget and the glass slider that is its floor. A painter asks with its OWN widget —
 * `glassAlphaFor(widget, role)`, `chromeIsDarkFor(widget)`, `glassTintFor(widget)` walk up to
 * the registered surface that contains it — so nothing is threaded through constructors, and a
 * popover parented inside a surface follows it for free.
 *
 * The skin is the shell's — dark, white ink — except on a surface that follows the system MODE
 * (`skinFromMode`: the dock, the app grid), which carries `nidara-skin-light`/`-dark` on its root
 * while the mode differs from the shell's, and where Hyalo said the content of the pane is dark
 * (`darkInkFor`, the ink — references/hyalo.md).
 *
 * Until 2026-10-13 this was the ADAPTIVE glass (#673): each surface measured its backdrop
 * (a screen capture minus an offscreen render of itself) and thickened its tint to keep text
 * legible. That measured Hyprland's blur; on Hyalo the compositor paints the glass and measures
 * under it itself, the capture was never taken there, and it went with #762.
 */

export type GlassRole = "bar" | "overlay" | "launcher" | "dock"

export interface GlassSurfaceOpts {
    /** For `dumpState`. */
    id: string
    /** The widget whose subtree wears the surface's glass. */
    root: Gtk.Widget
    /** Which glass slider is this surface's floor. */
    role: GlassRole
    /** The skin comes from the SYSTEM MODE, not from the shell's fixed dark one — the dock
     *  (owner, 2026-10-08, after measuring the reference: its dots follow the mode) and the
     *  app grid. On Hyalo its glass follows too, through `trackModeGlass`. */
    skinFromMode?: boolean
}

const surfaces = new Map<Gtk.Widget, GlassSurfaceOpts>()

const NEUTRAL_TINT: Rgb = { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }
const LIGHT_TINT: Rgb = { r: GLASS_TINT.light.r, g: GLASS_TINT.light.g, b: GLASS_TINT.light.b }

/** The skin a surface wears: the shell's — dark — or, for one that follows the system mode,
 *  the mode's. */
const skinOf = (s: GlassSurfaceOpts): boolean => s.skinFromMode ? Theme.isDark : Theme.chromeIsDark

function surfaceOf(widget: Gtk.Widget | null): GlassSurfaceOpts | null {
    for (let w: Gtk.Widget | null = widget; w; w = w.get_parent()) {
        const s = surfaces.get(w)
        if (s) return s
    }
    return null
}

const floorOf = (role: GlassRole) =>
    role === "bar" ? Theme.barOpacity
        : role === "dock" ? Theme.dockOpacity
            : role === "launcher"
                ? Math.max(Theme.overlayOpacity, GLASS_ROLE_FLOORS.launcher)
                : Theme.overlayOpacity

/** The opacity a glass painter inside `widget` should use for `role`: the user's slider, with
 *  the material's haze folded in (`frostedFill`) — pair it with `glassTintFor`. */
export function glassAlphaFor(_widget: Gtk.Widget | null, role: GlassRole): number {
    return frostedFill(NEUTRAL_TINT, floorOf(role)).alpha
}

/** The skin a shell-chrome painter inside `widget` should paint: its surface's (`skinOf`) —
 *  or light where Hyalo said the content of its pane of glass is dark (the ink, #684). */
export function chromeIsDarkFor(widget: Gtk.Widget | null): boolean {
    if (darkInkFor(widget)) return false
    const s = surfaceOf(widget)
    return s ? skinOf(s) : Theme.chromeIsDark
}

/** The TINT a glass painter inside `widget` should fill with: `GLASS_TINT` of its skin, under
 *  the haze for its surface's slider. Pair it with `chromeIsDarkFor` and `glassAlphaFor`. */
export function glassTintFor(widget: Gtk.Widget | null): Rgb {
    const s = surfaceOf(widget)
    const base = chromeIsDarkFor(widget) ? NEUTRAL_TINT : LIGHT_TINT
    return frostedFill(base, floorOf(s ? s.role : "overlay")).tint
}

/** Cairo painters do not repaint when an ancestor is queued — each DrawingArea has to be
 *  asked. The subtrees are panels, a few hundred widgets at most. */
function redrawSubtree(w: Gtk.Widget) {
    if (w instanceof Gtk.DrawingArea) w.queue_draw()
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) redrawSubtree(c)
}

/** The CSS half of a surface that follows the mode: a full token set scoped to its root
 *  (`generateSkinFlipScope`) while its skin differs from the shell's. */
function applySkinClass(s: GlassSurfaceOpts) {
    const isDark = skinOf(s)
    const flipped = isDark !== Theme.chromeIsDark
    s.root.remove_css_class("nidara-skin-dark")
    s.root.remove_css_class("nidara-skin-light")
    if (flipped) s.root.add_css_class(isDark ? "nidara-skin-dark" : "nidara-skin-light")
}

export function registerGlassSurface(opts: GlassSurfaceOpts): void {
    surfaces.set(opts.root, opts)
    applySkinClass(opts)
    opts.root.connect("destroy", () => surfaces.delete(opts.root))
}

/** What each surface wears — `dumpState.glass`, for agents and for verifying without a
 *  screenshot. */
export function shellGlassState() {
    const round = (v: number) => Math.round(v * 1000) / 1000
    return [...surfaces.values()].map(s => ({
        id: s.id,
        role: s.role,
        mapped: s.root.get_mapped(),
        floor: round(floorOf(s.role)),
        skin: skinOf(s) ? "dark" : "light",
        skinFrom: s.skinFromMode ? "mode" : "shell",
    }))
}

let wired = false
/** Called once from app.ts, after the surfaces exist. */
export function startShellGlass(): void {
    if (wired) return
    wired = true
    setGlassFrost(Theme.glassFrost)
    // A mode change moves the skin of the surfaces that follow it; a new haze or slider moves
    // every painter's fill (the Theme "changed" redraw each painter already holds).
    let lastMode = Theme.chromeIsDark
    let lastSystemMode = Theme.isDark
    Theme.connect("changed", () => {
        setGlassFrost(Theme.glassFrost)
        const modeChanged = Theme.chromeIsDark !== lastMode
        const systemModeChanged = Theme.isDark !== lastSystemMode
        lastMode = Theme.chromeIsDark
        lastSystemMode = Theme.isDark
        for (const s of surfaces.values()) {
            applySkinClass(s)
            if (modeChanged || (systemModeChanged && s.skinFromMode)) redrawSubtree(s.root)
        }
    })
}
