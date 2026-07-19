import { Gtk } from "ags/gtk4"
import SquircleContainer from "../../common/SquircleContainer"
import { MorphRevealer, MorphGlass } from "../../common/MorphRevealer"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"
import { CAPSULE_BORDER } from "../bar/capsule"
import Theme from "../../core/ThemeManager"
import status, { ISLAND_OVERVIEW } from "../../core/Status"
import WorkspaceOverview, { WO_GLASS } from "../overview/WorkspaceOverview"

// The Activity Island — the bar-center capsule as a MULTI-PURPOSE morphing
// surface. The capsule is the island's COMPACT state; each thing it can host
// (workspace overview today; media player, live alerts, the native agent
// later) is a registered MODE with its own expanded surface and glass recipe,
// all sharing one morph engine (common/MorphRevealer.ts) and one state field
// (status.island_mode, mutually exclusive with the other overlays).
//
// Design rules (agreed 2026-07-19):
// - COMPACT MUTATES BY ACTIVITY (full replacement, not an iOS-style split):
//   when a live activity exists, the capsule's compact content transforms into
//   that activity's compact form. Phase 2 machinery — today the compact state
//   is always the workspace dots.
// - EXPANSION IS EXPLICIT (click/keybind), except HIGH-PRIORITY events
//   (critical battery, agent needs confirmation) which may auto-expand.
//   Ambient state changes only ever touch the compact content.
// - The island hosts LIVE/STATEFUL things; transactional freedesktop
//   notifications stay in their banners/NC.
//
// Phase 1 (this file): the mode registry with the overview migrated as the
// first mode — one revealer per mode (each keeps its own glass recipe and
// content; only one is ever open, enforced by status.island_mode). The Bar
// stays the mount point: it appends `capsule` to its center box, mounts every
// `revealers` entry on its master overlay, and drives reveal/anchor/keyboard
// through the returned helpers on notify::island-mode.

export interface IslandMode {
    id: string
    /** Expanded surface, built once and revealed by the morph. May expose the
     *  morph handles (`morphContent`/`morphGlass`/`morphDots`) and nav hooks
     *  (`onOpen`/`handleKey`) — see MorphRevealer / WorkspaceOverview. */
    widget: Gtk.Widget
    /** Glass recipe of the expanded container (the morph's far end). */
    glass: () => MorphGlass
    /** Grab the keyboard EXCLUSIVE while this mode is open (keyboard-driven
     *  modes: overview cursor, future agent chat). */
    needsKeyboard?: boolean
}

export function ActivityIsland() {
    // ── Compact state: the workspace dots capsule ────────────────────────────
    // (Absorbed from the old surfaces/bar/Workspaces.tsx — the capsule belongs
    // to the island now; the bar just places it.)
    const box = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16 })
    const dots: Gtk.Widget[] = []
    for (let i = 1; i <= WS_COUNT; i++) {
        const dot = makeWorkspaceDot(i)
        dots.push(dot)
        box.append(dot)
    }
    const capsule = SquircleContainer({ child: box, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleIsland(ISLAND_OVERVIEW) })
    // Live dot refs for the morph: ghosts lerp FROM these bounds.
    ;(capsule as any).morphDots = dots

    // Both morph endpoints paint chrome glass (SquircleContainer chrome:true):
    // tint pinned by shellAppearance, alpha from the bar/overlay opacity axes.
    const chromeGlassColor = () => Theme.chromeIsDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
    // Pill of the compact capsule (perfect pill ≡ n=2, radius null = h/2).
    const compactGlass = (): MorphGlass => ({ alpha: Theme.barOpacity, color: chromeGlassColor(), border: CAPSULE_BORDER, n: 2.0, radius: null })

    // ── Mode registry ────────────────────────────────────────────────────────
    const modes = new Map<string, { mode: IslandMode, revealer: MorphRevealer }>()

    const registerMode = (mode: IslandMode) => {
        const w = mode.widget as any
        const revealer = new MorphRevealer(mode.widget, {
            getSourceWidget: () => capsule,
            contentTarget: w.morphContent ?? null,
            glassWidget: w.morphGlass ?? null,
            glassArea: (w.morphGlass as any)?.glassArea ?? null,
            // Traveling ghost dots only when the mode has landing dots.
            dots: w.morphDots ? {
                ghosts: Array.from({ length: WS_COUNT }, (_, i) => makeWorkspaceDot(i + 1)),
                getSource: (i: number) => ((capsule as any).morphDots?.[i] as Gtk.Widget) ?? null,
                getTarget: (i: number) => (w.morphDots?.[i] as Gtk.Widget) ?? null,
            } : null,
            glassFrom: compactGlass,
            glassTo: mode.glass,
        })
        // The island is the capsule GROWN, not a separate panel: top-anchored
        // (top edge pinned to the capsule by syncAnchor), centered like the
        // capsule — the morph only inflates down/sideways.
        revealer.valign = Gtk.Align.START
        revealer.halign = Gtk.Align.CENTER
        modes.set(mode.id, { mode, revealer })
    }

    // Phase 1: the overview is the island's first (and only) mode.
    registerMode({
        id: ISLAND_OVERVIEW,
        widget: WorkspaceOverview(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: WO_GLASS.border, n: WO_GLASS.n, radius: WO_GLASS.radius }),
        needsKeyboard: true,
    })

    const active = () => modes.get(status.island_mode) ?? null

    return {
        /** Compact state — the bar appends this to its center box. */
        capsule,
        /** All mode revealers — the bar mounts each on its master overlay and
         *  includes them in its input-region pass (visibility-gated there). */
        revealers: [...modes.values()].map(rt => rt.revealer),
        /** Reveal/hide every mode against status.island_mode. The bar passes
         *  its popToggle-equivalent so close keeps the input-region refresh. */
        sync: (reveal: (r: MorphRevealer, open: boolean) => void) => {
            for (const [id, rt] of modes) reveal(rt.revealer, status.island_mode === id)
        },
        /** True while the open mode wants the keyboard EXCLUSIVE. */
        needsKeyboard: () => active()?.mode.needsKeyboard === true,
        /** Seed the open mode's keyboard nav (call on open, after sync). */
        onOpened: () => { (active()?.mode.widget as any)?.onOpen?.() },
        /** Route a key to the open mode. */
        handleKey: (keyval: number): boolean => ((active()?.mode.widget as any)?.handleKey?.(keyval)) ?? false,
        /** Pin every revealer's top edge to the capsule's top (both wear their
         *  glass with the same 2px Cairo inset, so aligning the BOXES aligns
         *  the drawn edges). Falls back to the panel gap when the capsule is
         *  hidden (showWorkspaces off — matches the morph's centered-pop
         *  fallback). Call per-open, before the reveal. */
        syncAnchor: (relativeTo: Gtk.Widget, fallbackTop: number) => {
            let top = fallbackTop
            if (capsule.get_mapped()) {
                const [ok, b] = capsule.compute_bounds(relativeTo)
                if (ok) top = Math.round(b.get_y())
            }
            for (const rt of modes.values()) rt.revealer.margin_top = top
        },
    }
}

export type ActivityIslandHandle = ReturnType<typeof ActivityIsland>
