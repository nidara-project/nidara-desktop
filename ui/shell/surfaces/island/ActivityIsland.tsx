import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import SquircleContainer from "../../common/SquircleContainer"
import { MorphRevealer, MorphGlass, MorphPair } from "../../common/MorphRevealer"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"
import { CAPSULE_BORDER } from "../bar/capsule"
import Theme from "../../core/ThemeManager"
import status, { ISLAND_OVERVIEW, ISLAND_PLAYER, ISLAND_BATTERY, ISLAND_AGENT } from "../../core/Status"
import WorkspaceOverview, { WO_GLASS } from "../overview/WorkspaceOverview"
import PlayerIsland, { PLAYER_GLASS } from "./PlayerIsland"
import BatteryIsland, { BATTERY_GLASS } from "./BatteryIsland"
import AgentIsland, { AGENT_GLASS } from "./AgentIsland"
import { buildActivities } from "./IslandActivities"

// The Activity Island — the bar-center capsule as a MULTI-PURPOSE morphing
// surface. The capsule is the island's COMPACT state; each thing it can host
// (workspace overview, media player, battery alert; the native agent later)
// is a registered MODE with its own expanded surface and glass recipe, all
// sharing one morph engine (common/MorphRevealer.ts) and one state field
// (status.island_mode, mutually exclusive with the other overlays).
//
// Design rules (agreed 2026-07-19):
// - COMPACT MUTATES BY ACTIVITY (full replacement, not an iOS-style split):
//   when a live activity exists, the capsule's compact content transforms into
//   that activity's compact form.
// - EXPANSION IS EXPLICIT (click/keybind), except HIGH-PRIORITY events
//   (critical battery, agent needs confirmation) which may auto-expand.
//   Ambient state changes only ever touch the compact content.
// - The island hosts LIVE/STATEFUL things; transactional freedesktop
//   notifications stay in their banners/NC.
//
// Phase 3 (this file): the ACTIVITY REGISTRY. Activities are DATA — each one
// declares its compact form, a priority, a liveness signal and (optionally)
// an expanded mode + auto-expand policy (see IslandActivity below; the
// concrete activities live in IslandActivities.tsx). The engine here owns the
// arbitration: the highest-priority LIVE activity fronts the compact (the
// capsule's Gtk.Stack crossfades + interpolates size, so the pill reshapes
// with the swap); none live = the workspace dots. Clicking the capsule
// expands whatever fronts it. This is the mechanic the agent mode will ride
// (a "working" pill that expands when the agent needs a confirmation).

export interface IslandMode {
    id: string
    /** Expanded surface, built once and revealed by the morph. May expose the
     *  morph handles (`morphContent`/`morphGlass`/`morphDots`/`morphArt`) and
     *  nav hooks (`onOpen`/`handleKey`) — see MorphRevealer / WorkspaceOverview. */
    widget: Gtk.Widget
    /** Glass recipe of the expanded container (the morph's far end). */
    glass: () => MorphGlass
    /** Grab the keyboard EXCLUSIVE while this mode is open (keyboard-driven
     *  modes: overview cursor, future agent chat). */
    needsKeyboard?: boolean
}

/** One thing the island can show live status for. Declared as data; the
 *  engine below arbitrates which live activity fronts the compact. */
export interface IslandActivity {
    /** Compact page name in the capsule's stack. */
    id: string
    /** Higher wins the compact when several activities are live. Ambient
     *  media sits lowest; an active capture above it; critical alerts top. */
    priority: number
    /** The capsule's compact form while this activity fronts (carries its own
     *  side margins — 16px is the bar capsule family standard). */
    compact: Gtk.Widget
    /** Twin factory for the morph's source-dissolve track — called once per
     *  registered mode (a widget has ONE parent, so each revealer owns its own
     *  twin set). hideArt = this activity's flyer element FLIES in that mode
     *  (the flying ghost owns those pixels; the twin keeps the slot but
     *  paints it clear). */
    makeGhost?: (opts: { hideArt: boolean }) => Gtk.Widget
    /** Continuity pair: an element of this activity's compact FLIES into its
     *  expanded mode's `morphArt` slot (media's mini art → the panel's 96px
     *  artwork, battery's glyph → the alert's glyph). The ghost is built at
     *  the PANEL slot's natural size and scaled down by the morph so it stays
     *  sharp at both endpoints. */
    flyer?: {
        makeGhost: () => Gtk.Widget
        getSource: () => Gtk.Widget | null
    }
    /** Expanded mode opened by clicking the capsule while this activity
     *  fronts. Omit = the click falls back to the workspace overview. */
    expandMode?: string
    /** HIGH-priority only: expand automatically when this activity TAKES the
     *  front (once per takeover — closing the island while the condition
     *  persists must not re-open it). */
    autoExpand?: boolean
    /** Wire liveness; call `changed` whenever isLive() may have flipped. */
    watch: (changed: () => void) => void
    isLive: () => boolean
}

export function ActivityIsland() {
    // ── Compact state: dots page + one page per activity, in a morphing stack ─
    // (Dots absorbed from the old surfaces/bar/Workspaces.tsx — the capsule
    // belongs to the island now; the bar just places it.)
    // halign CENTER on every compact page: during the stack's width
    // interpolation the incoming page is allocated at the still-resizing pill
    // width — left-packed content rides the MOVING left edge and visibly
    // drifts sideways (user-caught 2026-07-20 on media→battery). Centered,
    // the pill condenses/expands symmetrically around the content. At rest
    // (allocation = natural width) CENTER and FILL are identical.
    const dotsBox = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
    const dots: Gtk.Widget[] = []
    for (let i = 1; i <= WS_COUNT; i++) {
        const dot = makeWorkspaceDot(i)
        dots.push(dot)
        dotsBox.append(dot)
    }
    // interpolate_size + non-homogeneous: the capsule's pill WIDTH animates
    // along with the crossfade when the compact mutates — one shape reshaping,
    // not a jump-cut (same principle as the big morph, GTK-native here).
    const COMPACT_SWAP_MS = 350
    const compactStack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: COMPACT_SWAP_MS,
        hhomogeneous: false,
        vhomogeneous: false,
        interpolate_size: true,
    })
    compactStack.add_named(dotsBox, "dots")
    const activities = buildActivities()
    for (const a of activities) compactStack.add_named(a.compact, a.id)

    // Expansion is EXPLICIT and follows the compact: the capsule opens what it
    // is currently showing. The overview always stays reachable via Super+W.
    let front: IslandActivity | null = null
    const capsule = SquircleContainer({ child: compactStack, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleIsland(front?.expandMode ?? ISLAND_OVERVIEW) })
    // Live dot refs for the morph: ghosts lerp FROM these bounds. (While the
    // compact shows an activity the dots are unmapped and MorphRevealer lets
    // the overview's landing dots ride the content fade instead.)
    ;(capsule as any).morphDots = dots

    // ── Arbitration: WHICH live activity fronts the compact ──────────────────
    // Liveness POLICY stays inside each activity (media owns its pause grace,
    // battery its hysteresis) — the engine only picks the winner and applies
    // the two cross-activity rules: a dead activity's expanded surface closes,
    // and an auto-expand activity opens its surface when it takes the front.
    let autoExpandTimer: number | null = null
    const arbitrate = () => {
        const live = activities.filter(a => a.isLive())
        const next = live.length ? live.reduce((m, a) => (a.priority > m.priority ? a : m)) : null
        if (next === front) return
        const prev = front
        front = next
        compactStack.visible_child_name = front?.id ?? "dots"
        // The thing the open surface was showing is GONE (player left the bus,
        // battery recovered) — close it; a mere front takeover by a higher
        // priority leaves a still-live activity's surface open.
        if (prev?.expandMode && status.island_mode === prev.expandMode && !prev.isLive())
            status.island_mode = ""
        if (front?.autoExpand && front.expandMode) {
            // SEQUENCED, not immediate: the compact mutation (crossfade + pill
            // resize + the new page's first allocation) must LAND before the
            // morph reads the capsule as its source — expanding in the same
            // tick grew the island out of a still-resizing pill (visible
            // re-seat) and dissolved a compact form the user never saw settle
            // (a phantom red % — user-caught 2026-07-20). One beat after the
            // swap it reads as two deliberate steps: mutate, then open.
            const a = front
            if (autoExpandTimer !== null) GLib.source_remove(autoExpandTimer)
            autoExpandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMPACT_SWAP_MS + 80, () => {
                autoExpandTimer = null
                if (front === a && a.isLive()) status.island_mode = a.expandMode!
                return GLib.SOURCE_REMOVE
            })
        }
    }
    for (const a of activities) a.watch(arbitrate)
    // Closing a mode can end a liveness clause (media holds its compact while
    // its panel is open; a pause grace may have expired underneath).
    status.connect("notify::island-mode", () => { if (status.island_mode === "") arbitrate() })
    arbitrate()

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
        // The flyer pair belongs to the mode's OWNER activity (the one whose
        // expandMode is this mode): its compact element flies into the mode's
        // morphArt slot. The pair is skipped frame-by-frame while another
        // activity fronts the compact (source unmapped → landing element
        // rides the content fade).
        const owner = activities.find(a => a.expandMode === mode.id && a.flyer)
        if (w.morphArt && owner) pairs.push({
            ghost: owner.flyer!.makeGhost(),
            getSource: () => (front === owner ? owner.flyer!.getSource() : null),
            getTarget: () => (w.morphArt as Gtk.Widget) ?? null,
        })
        // Source-dissolve twins: whatever activity fronts the compact melts
        // into the growing island for EVERY mode (opening the overview over
        // playing music must not blink the compact out either). The dots page
        // needs no twin — its landing pairs ARE the continuity; known gap: a
        // mode opened via IPC while the compact shows dots still blinks them
        // out (no landing slot to fly to) — rare, agent path only. hideArt
        // only for the OWNER's twin: only its element actually flies here.
        const twins = new Map<string, Gtk.Widget>()
        for (const a of activities)
            if (a.makeGhost) twins.set(a.id, a.makeGhost({ hideArt: !!w.morphArt && a === owner }))
        const revealer = new MorphRevealer(mode.widget, {
            getSourceWidget: () => capsule,
            contentTarget: w.morphContent ?? null,
            glassWidget: w.morphGlass ?? null,
            glassArea: (w.morphGlass as any)?.glassArea ?? null,
            pairs,
            sourceGhosts: [...twins.values()],
            getSourceGhost: () => (front ? twins.get(front.id) ?? null : null),
            getSourceContent: () => front?.compact ?? null,
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
    // No keyboard grab either: the battery alert is dismissed by outside click
    // / Esc-less design, same ambient contract as the player.
    registerMode({
        id: ISLAND_BATTERY,
        widget: BatteryIsland(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: BATTERY_GLASS.border, n: BATTERY_GLASS.n, radius: BATTERY_GLASS.radius }),
    })
    // Keyboard grab: the assistant has a text entry (like the overview cursor
    // needs keys, this needs the entry to receive them — the bar grants EXCLUSIVE
    // while needsKeyboard). handleKey only claims Escape; the rest reaches the entry.
    registerMode({
        id: ISLAND_AGENT,
        widget: AgentIsland(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: AGENT_GLASS.border, n: AGENT_GLASS.n, radius: AGENT_GLASS.radius }),
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
