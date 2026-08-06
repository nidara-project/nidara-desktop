import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import SquircleContainer from "../../common/SquircleContainer"
import { MorphRevealer, MorphGlass, MorphPair } from "../../common/MorphRevealer"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"
import { CAPSULE_BORDER } from "../bar/capsule"
import Theme from "../../core/ThemeManager"
import status, { ISLAND_OVERVIEW, ISLAND_PLAYER, ISLAND_BATTERY, ISLAND_AGENT, ISLAND_RECORDING } from "../../core/Status"
import WorkspaceOverview, { WO_GLASS } from "../overview/WorkspaceOverview"
import PlayerIsland, { PLAYER_GLASS } from "./PlayerIsland"
import BatteryIsland, { BATTERY_GLASS } from "./BatteryIsland"
import RecordingIsland, { RECORDING_GLASS } from "./RecordingIsland"
import AgentIsland, { AGENT_GLASS } from "./AgentIsland"
import { buildActivities, DOTS_ID } from "./IslandActivities"

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
// with the swap). The workspace dots are an activity too — priority 0, always
// live — so "nothing else running" is not a special case, it is just the dots
// winning. Clicking the capsule expands whatever fronts it. This is the
// mechanic the agent mode rides (a "working" pill that expands when the agent
// needs a confirmation).
//
// The live activities that DON'T front are published as `background` for the
// indicator row (iOS-style: the front is the capsule, the rest are icons beside
// it). Nothing paints them yet — that's the next step.

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
    /** Expanded mode opened by clicking the capsule (or this activity's chip)
     *  while it fronts. Omit = there is no island surface for it, and the click
     *  falls to `onExpand`. It does NOT fall back to the workspace overview:
     *  that fallback made sense only while the overview was the capsule's
     *  default identity, and once the dots became an activity with a mode of
     *  their own it just meant an unrelated surface answering the click
     *  (user-caught 2026-08-01 on the recording pill). */
    expandMode?: string
    /** What a click does when this activity has no island mode of its own —
     *  the destination where the user can actually act on it. Recording sends
     *  you to the Control Center, which is where its Stop lives. */
    onExpand?: () => void
    /** HIGH-priority only: expand automatically when this activity TAKES the
     *  front (once per takeover — closing the island while the condition
     *  persists must not re-open it). */
    autoExpand?: boolean
    /** The activity's glyph in the INDICATOR ROW — what it looks like while it
     *  is live but something else fronts the capsule. Built once by the row.
     *  Required, not optional: an activity with no glyph would simply vanish
     *  from the desktop whenever anything outranked it, which is the failure
     *  the row exists to fix. Keep it ~16px of ink, the icon weight of the bar. */
    indicator: () => Gtk.Widget
    /** Wire liveness; call `changed` whenever isLive() may have flipped. */
    watch: (changed: () => void) => void
    isLive: () => boolean
    /** Show a chip WITHOUT competing for the front. Defaults to `isLive` — an
     *  activity is normally indicated exactly when it is running. The Assistant
     *  overrides it: once a provider is configured it is always one click away,
     *  because the filtering already happened (you turned on an experimental
     *  feature AND entered a key). Liveness cannot express that — an activity
     *  that claimed to be live while idle would take the capsule from the music
     *  and never give it back. */
    isIndicated?: () => boolean
}

/** How many indicators can show at once. Beyond this the lowest-priority live
 *  activities are simply not drawn: the row is a glance, and a fourth chip
 *  pushes the capsule far enough off-centre that the bar stops reading as
 *  centred at all. */
const INDICATOR_MAX = 3

/** A chip's width. Its HEIGHT is whatever the bar row gives it — the chips sit
 *  in the same box as the capsule, so they match it by construction instead of
 *  by a duplicated constant. 32 is that height, which is what turns `perfect`'s
 *  h/2 radius into a circle rather than a pill. */
const CHIP_W = 32

/** Gap before each chip — the bar's rhythm between capsules. It lives on the
 *  chip's margin rather than the box's spacing so it collapses with the chip;
 *  see the row's comment. */
const CHIP_GAP = 8

/** `gdkmonitor` is the monitor this bar (and therefore this island) lives on.
 *  Only the overview needs it today — its cards are sized as a fraction of the
 *  screen rather than to a constant — but it is the island's own monitor, so it
 *  belongs on the island's signature rather than being fetched from anywhere. */
export function ActivityIsland(gdkmonitor: Gdk.Monitor) {
    // ── Compact state: one page per activity, in a morphing stack ────────────
    // The workspace dots are an activity too (priority 0, always live — see
    // IslandActivities' dotsActivity), so there is no separate dots page and no
    // `else` branch in the arbitration below: the dots are simply what fronts
    // the capsule when nothing outranks them.
    // halign CENTER on every compact page: during the stack's width
    // interpolation the incoming page is allocated at the still-resizing pill
    // width — left-packed content rides the MOVING left edge and visibly
    // drifts sideways (user-caught 2026-07-20 on media→battery). Centered,
    // the pill condenses/expands symmetrically around the content. At rest
    // (allocation = natural width) CENTER and FILL are identical.
    //
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
    // buildActivities returns the dots first, so the stack's initial visible
    // child is the dots page — the capsule's resting form, before the first
    // arbitration has run.
    const activities = buildActivities()
    for (const a of activities) compactStack.add_named(a.compact, a.id)
    const dotsAct = activities.find(a => a.id === DOTS_ID)!

    // Expansion is EXPLICIT and follows the compact: the capsule opens what it
    // is currently showing — its own island mode, or, for an activity that has
    // none, wherever the user can actually act on it (`onExpand`). Nothing at
    // all if it has neither: answering with an unrelated surface is worse than
    // not answering. The overview always stays reachable via Super+W, and now
    // also via the workspaces' own chip.
    let front: IslandActivity | null = null
    const openFront = () => {
        if (front?.expandMode) status.toggleIsland(front.expandMode)
        else front?.onExpand?.()
    }
    const capsule = SquircleContainer({ child: compactStack, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => openFront() })
    // Live dot refs for the morph: ghosts lerp FROM these bounds. (While the
    // compact shows another activity the dots are unmapped and MorphRevealer
    // lets the overview's landing dots ride the content fade instead.)
    ;(capsule as any).morphDots = (dotsAct.compact as any).dots as Gtk.Widget[]

    // ── Arbitration: WHICH live activity fronts the compact ──────────────────
    // Liveness POLICY stays inside each activity (media owns its pause grace,
    // battery its hysteresis) — the engine only picks the winner and applies
    // the two cross-activity rules: a dead activity's expanded surface closes,
    // and an auto-expand activity opens its surface when it takes the front.
    //
    // The losers are NOT discarded: they are published as `background` (every
    // live activity that isn't fronting), which is exactly what the indicator
    // row paints. Order is by PRIORITY, never by arrival — an arrival-ordered
    // row would make the icons swap places under the user's cursor.
    let background: IslandActivity[] = []
    const backgroundSubs: Array<() => void> = []
    let autoExpandTimer: number | null = null
    // A chip click PINS its activity to the front, because priority is a guess
    // about what matters and a click is not. The pin outlives every ordinary
    // change and ends only when the user picks something else or the pinned
    // activity dies — otherwise "put the workspaces back" would last exactly
    // until the next track change.
    let pinned: IslandActivity | null = null

    // Open a mode ONE BEAT after the compact mutation, never in the same tick:
    // the crossfade, the pill's width interpolation and the new page's first
    // allocation must LAND before the morph reads the capsule as its source.
    // Expanding immediately grew the island out of a still-resizing pill and
    // dissolved a compact form the user never saw settle (a phantom red % —
    // user-caught 2026-07-20). Two deliberate steps: mutate, then open. Shared
    // by auto-expand and by a chip click, which need exactly the same beat.
    // ISLAND MODES ONLY, on purpose. The beat exists because the island cannot
    // grow out of a pill that is still interpolating its width; jumping to
    // another surface (`onExpand`) is not a morph and has no such constraint —
    // and, more to the point, must not happen here at all: taking the front is
    // "show this in the capsule", and yanking the user to a different surface
    // because an activity CHANGED is not the same act as asking for it.
    // Expanding stays an explicit second click (user call, 2026-08-01).
    const openAfterSwap = (a: IslandActivity) => {
        if (!a.expandMode) return
        if (autoExpandTimer !== null) GLib.source_remove(autoExpandTimer)
        autoExpandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMPACT_SWAP_MS + 80, () => {
            autoExpandTimer = null
            // Still the front and still live: the beat is long enough for the
            // world to have moved on (the turn ended, the battery recovered).
            if (front === a && a.isLive()) status.island_mode = a.expandMode!
            return GLib.SOURCE_REMOVE
        })
    }

    const arbitrate = () => {
        const live = activities.filter(a => a.isLive())
        // The dots activity is always live, so `live` is never empty and the
        // compact always has a front.
        const top = live.reduce((m, a) => (a.priority > m.priority ? a : m))
        if (pinned && !pinned.isLive()) pinned = null
        // The pin holds the front against priority — with ONE exception: an
        // auto-expanding activity (a critical battery) exists to interrupt, so
        // it takes the front anyway. It does not CLEAR the pin: when the
        // interruption passes, what the user chose comes back.
        const next = pinned && !(top.autoExpand && top !== pinned) ? pinned : top
        // The row is everything INDICATED that isn't fronting — which is wider
        // than "live": an activity can earn a chip without being able to take
        // the capsule (see isIndicated).
        const back = activities
            .filter(a => a !== next && (a.isLive() || a.isIndicated?.()))
            .sort((x, y) => y.priority - x.priority)
        // The front can hold steady while the background changes (music starts
        // under a critical battery), so this is computed before the early-out.
        const backChanged = back.length !== background.length || back.some((a, i) => a !== background[i])
        background = back
        if (next === front) {
            if (backChanged) for (const cb of backgroundSubs) cb()
            return
        }
        const prev = front
        front = next
        compactStack.visible_child_name = front.id
        // The thing the open surface was showing is GONE (player left the bus,
        // battery recovered) — close it; a mere front takeover by a higher
        // priority leaves a still-live activity's surface open.
        if (prev?.expandMode && status.island_mode === prev.expandMode && !prev.isLive())
            status.island_mode = ""
        if (front.autoExpand) openAfterSwap(front)
        if (backChanged) for (const cb of backgroundSubs) cb()
    }

    // A chip click: take the front, and open IF opening means expanding the
    // island in place. Not just open — the row's whole claim is that the
    // capsule shows what you are dealing with, so picking one has to move it
    // there. But an activity whose destination is another surface entirely
    // (recording → the Control Center) only gets promoted: switching the
    // capsule to it is not the same act as asking to go there, and one click
    // should not do both. Its second click, on the capsule, does the jump.
    const promote = (a: IslandActivity) => {
        // Only a LIVE activity can be pinned. The pin settles who owns the
        // capsule among things that are RUNNING; a merely INDICATED chip (the
        // idle assistant) has nothing to hold it with, and pinning it would
        // either be cleared on the spot by the liveness check or — worse, if it
        // weren't — park an idle activity in the capsule forever. Clicking it
        // just opens it, which is what makes it live: the same path Super+A
        // takes, where the island-mode change is what re-arbitrates the compact.
        if (a.isLive()) {
            pinned = a
            arbitrate()
            openAfterSwap(a)
        } else if (a.expandMode) {
            status.island_mode = a.expandMode
        } else {
            // Nothing to promote it to and no island mode: "go there" is the
            // only meaning the click has left. (Unreachable today — the one
            // indicated-but-idle activity is the assistant, which has a mode.)
            a.onExpand?.()
        }
    }
    // ── The indicator row ────────────────────────────────────────────────────
    // The live activities that are NOT fronting, as chips beside the capsule —
    // the iOS split: one pill carrying the current thing, small circles for the
    // rest. Every chip is built ONCE and packed in DESCENDING priority order,
    // which buys two things: the visible subset is automatically in priority
    // order without ever reordering the box (icons that swap places under the
    // cursor were the thing to avoid), and each chip's rect stays put for the
    // input region.
    // No box spacing here or in the bar's centre box: a collapsed Gtk.Revealer
    // still counts as a visible child, so spacing would reserve 8px per chip
    // forever and push the capsule off-centre in an idle session. The gap rides
    // each chip's margin_start instead, so it slides in WITH the chip and
    // collapses to nothing with it.
    const indicatorRow = new Gtk.Box({ halign: Gtk.Align.CENTER })
    const chips = new Map<string, { revealer: Gtk.Revealer, hit: Gtk.Widget }>()
    for (const a of [...activities].sort((x, y) => y.priority - x.priority)) {
        const glyph = a.indicator()
        glyph.halign = Gtk.Align.CENTER
        glyph.valign = Gtk.Align.CENTER
        // Same glass recipe as the capsule — a sibling shape, not a new
        // material. `perfect` makes the radius h/2, so at CHIP_W ≈ the row
        // height it lands as a circle. Same hover accent too: a chip is a
        // control, and it answers a click the way the capsule does.
        const chip = SquircleContainer({ child: glyph, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => promote(a) })
        chip.width_request = CHIP_W
        chip.margin_start = CHIP_GAP
        // Gtk.Revealer, not ScaleRevealer: this is a HORIZONTAL appearance and
        // ScaleRevealer animates the measured HEIGHT only (it passes width
        // straight through), so a chip would pop to full width and shove the
        // capsule sideways in one frame. SLIDE_RIGHT is the bar's existing
        // idiom for an element that comes and goes (widgets/bar-helpers.ts).
        // Duration = the compact swap's, so when a chip appears BECAUSE the
        // front changed, the capsule's width interpolation and the row's
        // widening are one settling movement instead of two.
        const revealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_RIGHT,
            transition_duration: COMPACT_SWAP_MS,
            reveal_child: false,
        })
        revealer.set_child(chip)
        indicatorRow.append(revealer)
        chips.set(a.id, { revealer, hit: chip })
    }
    const syncIndicators = () => {
        const shown = new Set(background.slice(0, INDICATOR_MAX).map(a => a.id))
        for (const [id, c] of chips) c.revealer.reveal_child = shown.has(id)
    }
    backgroundSubs.push(syncIndicators)

    for (const a of activities) a.watch(arbitrate)
    // Closing a mode can end a liveness clause (media holds its compact while
    // its panel is open; a pause grace may have expired underneath).
    status.connect("notify::island-mode", () => { if (status.island_mode === "") arbitrate() })
    arbitrate()
    // The first arbitration runs before the subscription above could fire (and
    // `backChanged` is false when the session starts idle), so seed the row.
    syncIndicators()

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
            // The chips leave with the capsule's content. Every mode gets the
            // same row (only one revealer animates at a time, so they cannot
            // fight over its opacity).
            companions: [indicatorRow],
        })
        // The island is the capsule GROWN, not a separate panel: top-anchored
        // (top edge pinned to the capsule by syncAnchor), centered like the
        // capsule — the morph only inflates down/sideways. Both the capsule and
        // this revealer live in the ISLAND's surface (IslandWindow.ts), which is
        // exactly the monitor rect, so CENTER here and the capsule's own CENTER
        // land on the same axis with no correction.
        revealer.valign = Gtk.Align.START
        revealer.halign = Gtk.Align.CENTER
        modes.set(mode.id, { mode, revealer })
    }

    registerMode({
        id: ISLAND_OVERVIEW,
        widget: WorkspaceOverview(gdkmonitor),
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
    // No keyboard grab: the capture card is a statement + Stop, dismissed by
    // outside click / capsule click like the player and the battery alert.
    registerMode({
        id: ISLAND_RECORDING,
        widget: RecordingIsland(),
        glass: () => ({ alpha: Theme.overlayOpacity, color: chromeGlassColor(), border: RECORDING_GLASS.border, n: RECORDING_GLASS.n, radius: RECORDING_GLASS.radius }),
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
        /** The indicator chips — appended to the same centre box, right of the
         *  capsule, so the GROUP is what centres on the monitor. */
        indicatorRow,
        /** Everything on this surface the user can hit, RE-READ on every input
         *  region stamp. The capsule is always in: it keeps its geometry while a
         *  mode is open (it is switched off by opacity alone, and clicking it
         *  closes the mode). The chips are not: while a mode is open they are
         *  faded to nothing, and leaving their rects stamped would put an
         *  invisible dead patch in the bar: the compositor would read a press
         *  there as INSIDE the grab and neither dismiss nor pass it on. Collapsed
         *  chips fall out on the caller's zero-size guard. */
        hitTargets: () => indicatorRow.opacity === 0
            ? [capsule as Gtk.Widget]
            : [capsule as Gtk.Widget, ...[...chips.values()].map(c => c.hit)],
        /** Every LIVE activity that is NOT fronting the capsule, highest
         *  priority first — the model the indicator row paints. Idle session =
         *  only the dots are live = empty list, which is why the bar looks
         *  unchanged until something else runs. */
        background: () => background,
        /** Fire when that list changes (membership or order). */
        onBackgroundChanged: (cb: () => void) => { backgroundSubs.push(cb) },
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
         *  hidden or not yet mapped (matches the morph's centered-pop
         *  fallback). Call per-open, before the reveal.
         *
         *  `relativeTo` is the ISLAND surface's root: the capsule was moved onto
         *  that surface with the revealers, so this is an ordinary same-window
         *  measurement again (it used to cross into the bar's window). */
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
