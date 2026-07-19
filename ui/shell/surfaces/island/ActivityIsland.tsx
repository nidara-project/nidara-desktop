import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalMpris from "gi://AstalMpris"
import SquircleContainer from "../../common/SquircleContainer"
import { MorphRevealer, MorphGlass, MorphPair } from "../../common/MorphRevealer"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"
import { CAPSULE_BORDER } from "../bar/capsule"
import Theme from "../../core/ThemeManager"
import status, { ISLAND_OVERVIEW, ISLAND_PLAYER } from "../../core/Status"
import * as media from "../../core/MediaService"
import { safeDisconnect } from "../../core/signals"
import WorkspaceOverview, { WO_GLASS } from "../overview/WorkspaceOverview"
import PlayerIsland, { PlayerCompact, makeArtGhost, PLAYER_GLASS } from "./PlayerIsland"

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
// Phase 1: the mode registry with the overview migrated as the first mode —
// one revealer per mode (each keeps its own glass recipe and content; only one
// is ever open, enforced by status.island_mode). The Bar stays the mount
// point: it appends `capsule` to its center box, mounts every `revealers`
// entry on its master overlay, and drives reveal/anchor/keyboard through the
// returned helpers on notify::island-mode.
//
// Phase 2 (this file): COMPACT MUTATION + the player mode. The capsule's
// content is a Gtk.Stack (crossfade + interpolate_size, so the pill's width
// animates with the swap) holding one page per compact form: the workspace
// dots (neutral state) and the media compact (PlayerCompact). The activity
// controller below OWNS the policy: playing media mutates the compact; pause
// holds it for a grace window before reverting; the player leaving the bus
// reverts instantly (and closes the expanded player). Clicking the capsule
// expands whatever the compact is currently showing.

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
    // ── Compact state: dots page + player page in a morphing stack ──────────
    // (Dots absorbed from the old surfaces/bar/Workspaces.tsx — the capsule
    // belongs to the island now; the bar just places it.)
    const dotsBox = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16 })
    const dots: Gtk.Widget[] = []
    for (let i = 1; i <= WS_COUNT; i++) {
        const dot = makeWorkspaceDot(i)
        dots.push(dot)
        dotsBox.append(dot)
    }
    // interpolate_size + non-homogeneous: the capsule's pill WIDTH animates
    // along with the crossfade when the compact mutates — one shape reshaping,
    // not a jump-cut (same principle as the big morph, GTK-native here).
    const compactStack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: 350,
        hhomogeneous: false,
        vhomogeneous: false,
        interpolate_size: true,
    })
    compactStack.add_named(dotsBox, "dots")
    const playerPage = PlayerCompact()
    compactStack.add_named(playerPage, "player")
    // Expansion is EXPLICIT and follows the compact: the capsule opens what it
    // is currently showing. The overview always stays reachable via Super+W.
    let activityLive = false
    const capsule = SquircleContainer({ child: compactStack, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleIsland(activityLive ? ISLAND_PLAYER : ISLAND_OVERVIEW) })
    // Live dot refs for the morph: ghosts lerp FROM these bounds. (While the
    // compact shows the player the dots are unmapped and MorphRevealer lets
    // the overview's landing dots ride the content fade instead.)
    ;(capsule as any).morphDots = dots

    // ── Activity controller: WHEN the compact mutates ───────────────────────
    // Playing media is an AMBIENT activity — it mutates the compact, never
    // auto-expands (auto-expansion is reserved for high-priority events).
    // Pause keeps the player form for a grace window (track changes and short
    // pauses must not flicker dots↔player); the player leaving the bus reverts
    // instantly and closes the expanded player if it was open.
    const PAUSE_GRACE_S = 12
    let graceTimer: number | null = null
    let curPlayer: any = null
    let playerSig: number | null = null

    const cancelGrace = () => {
        if (graceTimer !== null) { GLib.source_remove(graceTimer); graceTimer = null }
    }
    const setCompact = (playerForm: boolean) => {
        if (activityLive === playerForm) return
        activityLive = playerForm
        compactStack.visible_child_name = playerForm ? "player" : "dots"
    }
    const evaluate = () => {
        const playing = curPlayer?.playback_status === AstalMpris.PlaybackStatus.PLAYING
        if (playing) {
            cancelGrace()
            setCompact(true)
        } else if (!curPlayer) {
            cancelGrace()
            setCompact(false)
            if (status.island_mode === ISLAND_PLAYER) status.island_mode = ""
        } else if (activityLive && graceTimer === null) {
            graceTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PAUSE_GRACE_S, () => {
                graceTimer = null
                // The user is looking at the open player panel — hold the
                // compact; the island-mode close below re-evaluates.
                if (status.island_mode !== ISLAND_PLAYER) setCompact(false)
                return GLib.SOURCE_REMOVE
            })
        }
    }
    const rewire = () => {
        safeDisconnect(curPlayer, playerSig); playerSig = null
        curPlayer = media.selectedPlayer()
        if (curPlayer) playerSig = curPlayer.connect("notify::playback-status", evaluate)
        evaluate()
    }
    media.subscribe(rewire)
    // A pause grace may have expired while the expanded player was open.
    status.connect("notify::island-mode", () => { if (status.island_mode === "") evaluate() })
    rewire()

    // Both morph endpoints paint chrome glass (SquircleContainer chrome:true):
    // tint pinned by shellAppearance, alpha from the bar/overlay opacity axes.
    const chromeGlassColor = () => Theme.chromeIsDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
    // Pill of the compact capsule (perfect pill ≡ n=2, radius null = h/2).
    const compactGlass = (): MorphGlass => ({ alpha: Theme.barOpacity, color: chromeGlassColor(), border: CAPSULE_BORDER, n: 2.0, radius: null })

    // ── Mode registry ────────────────────────────────────────────────────────
    const modes = new Map<string, { mode: IslandMode, revealer: MorphRevealer }>()

    const registerMode = (mode: IslandMode) => {
        const w = mode.widget as any
        // Traveling twins, one set per revealer (a widget has ONE parent):
        // capsule dots → the mode's landing dots; compact cover art → the
        // mode's art slot. Pairs whose source page isn't the live compact are
        // skipped frame-by-frame inside MorphRevealer (rectOf → unmapped).
        const pairs: MorphPair[] = []
        if (w.morphDots) {
            for (let i = 0; i < WS_COUNT; i++) pairs.push({
                ghost: makeWorkspaceDot(i + 1),
                getSource: () => ((capsule as any).morphDots?.[i] as Gtk.Widget) ?? null,
                getTarget: () => (w.morphDots?.[i] as Gtk.Widget) ?? null,
            })
        }
        if (w.morphArt) pairs.push({
            ghost: makeArtGhost(),
            getSource: () => ((playerPage as any).artDa as Gtk.Widget) ?? null,
            getTarget: () => (w.morphArt as Gtk.Widget) ?? null,
        })
        const revealer = new MorphRevealer(mode.widget, {
            getSourceWidget: () => capsule,
            contentTarget: w.morphContent ?? null,
            glassWidget: w.morphGlass ?? null,
            glassArea: (w.morphGlass as any)?.glassArea ?? null,
            pairs,
            // Media compact content (title/EQ/art) dissolves into the growing
            // island whenever the compact is on the player page — for EVERY
            // mode (opening the overview over playing music must not blink
            // the compact out either). The dots page needs no source ghost
            // when its landing dots exist (the pairs ARE the continuity);
            // known gap: `togglePlayer` via IPC while the compact shows dots
            // still blinks them out (no landing slot to fly to) — rare, agent
            // path only. Modes with an art pair get a twin with a transparent
            // art slot: the flying art ghost owns those pixels.
            sourceGhost: PlayerCompact({ ghost: true, hideArt: !!w.morphArt }),
            getSourceContent: () => playerPage,
            getSourceGhostOn: () => activityLive,
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

    registerMode({
        id: ISLAND_OVERVIEW,
        widget: WorkspaceOverview(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: WO_GLASS.border, n: WO_GLASS.n, radius: WO_GLASS.radius }),
        needsKeyboard: true,
    })
    // No keyboard grab: the player panel is ambient — media keys and app focus
    // keep working; it closes on outside click / capsule click like CC.
    registerMode({
        id: ISLAND_PLAYER,
        widget: PlayerIsland(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: PLAYER_GLASS.border, n: PLAYER_GLASS.n, radius: PLAYER_GLASS.radius }),
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
