import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalMpris from "gi://AstalMpris"
import AstalBattery from "gi://AstalBattery"
import status, { ISLAND_OVERVIEW, ISLAND_PLAYER, ISLAND_BATTERY, ISLAND_AGENT, ISLAND_RECORDING, recordingElapsed } from "../../core/Status"
import * as media from "../../core/MediaService"
import { safeDisconnect } from "../../core/signals"
import { PlayerCompact, makeArtGhost, makeMiniArt } from "./PlayerIsland"
import { AgentCompact } from "./AgentIsland"
import agentService from "../../core/AgentService"
import agentConfig from "../../core/AgentConfig"
import { makeBatteryGlyph, batteryPresent, batteryFrac } from "../../common/BatteryGlyph"
import { makeWorkspaceDot, makeActiveDotGlyph, WS_COUNT } from "../../common/WorkspaceDot"
import Icons from "../../core/Icons"
import type { IslandActivity } from "./ActivityIsland"

// The island's ACTIVITIES — the concrete things the capsule can show live
// status for, declared as data for ActivityIsland's arbitration engine (see
// the IslandActivity interface there for the contract). Each activity OWNS
// its liveness policy: media its pause grace, battery its hysteresis. The
// engine only picks the highest-priority live one.
//
// Priorities (spacing of 10 leaves room to slot things between):
//   dots 0 < media 10 < recording 20 < agent 25 < battery-critical 30
// An active capture outranks ambient playback (it's the rarer, more
// consequential state); a critically-low battery outranks everything (it is
// ALSO the auto-expand prototype — the agent's "needs confirmation" will ride
// the same flag). The workspace dots sit at the FLOOR and are always live —
// see dotsActivity below.

// ── Workspace dots: the island's FLOOR, always live ──────────────────────────
// Priority 0 with `isLive: () => true`, which makes the dots an activity like
// any other instead of the arbitration's `else` branch. That `else` was a real
// bug: with anything live (music playing) the capsule showed THAT activity and
// its click opened THAT mode, so the workspace overview stopped being reachable
// with the mouse at all. As an activity the dots merely lose the FRONT to a
// higher priority and stay in the live set, which is what the indicator row
// paints. Idle session = nothing else live = the dots front the capsule and the
// bar looks exactly as it always has.
//
// No `makeGhost`: the dots' morph continuity is the TRAVELING PAIR set (each
// capsule dot flies to the overview's landing dot — see ActivityIsland's
// registerMode), not a dissolving twin.
export const DOTS_ID = "dots"

function dotsActivity(): IslandActivity {
    // spacing 10 (dots are small — the other activity forms use 8), 16px side
    // margins and halign CENTER: the bar capsule family standard.
    const box = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
    const dots: Gtk.Widget[] = []
    for (let i = 1; i <= WS_COUNT; i++) {
        const dot = makeWorkspaceDot(i)
        dots.push(dot)
        box.append(dot)
    }
    // The live dot refs the morph's traveling ghosts lerp FROM (same idiom as
    // battery's `.glyph`): ActivityIsland republishes them as capsule.morphDots.
    ;(box as any).dots = dots
    return {
        id: DOTS_ID,
        priority: 0,
        compact: box,
        expandMode: ISLAND_OVERVIEW,
        indicator: makeActiveDotGlyph,
        watch: () => {},            // always live: nothing can change it
        isLive: () => true,
    }
}

// ── Media (ambient): playing mutates the compact, never auto-expands ─────────
function mediaActivity(): IslandActivity {
    const compact = PlayerCompact()
    // Pause keeps the player form for a grace window (track changes and short
    // pauses must not flicker dots↔player); the player leaving the bus drops
    // liveness instantly (the engine then closes an open player panel).
    const PAUSE_GRACE_S = 12
    let grace: number | null = null
    let curPlayer: any = null
    let sig: number | null = null
    let wasPlaying = false
    let changed: () => void = () => {}

    // Indicator covers, refreshed by the player rewire below. Each one repaints
    // only when the cover PATH changed (see makeCoverArt.refresh): the generic
    // `notify` ticks at 1 Hz while playing, and a chip that redrew on every tick
    // would cost the compositor a blur pass over the island once a second.
    const artRefreshers: Array<() => void> = []
    const cancelGrace = () => {
        if (grace !== null) { GLib.source_remove(grace); grace = null }
    }
    const onStatus = () => {
        const playing = curPlayer?.playback_status === AstalMpris.PlaybackStatus.PLAYING
        if (playing) cancelGrace()
        else if (wasPlaying && curPlayer && grace === null) {
            grace = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PAUSE_GRACE_S, () => {
                grace = null
                changed()
                return GLib.SOURCE_REMOVE
            })
        }
        wasPlaying = playing
        changed()
    }
    let artSig: number | null = null
    const rewire = () => {
        safeDisconnect(curPlayer, sig); sig = null
        safeDisconnect(curPlayer, artSig); artSig = null
        curPlayer = media.selectedPlayer()
        if (curPlayer) {
            sig = curPlayer.connect("notify::playback-status", onStatus)
            // The cover rides the GENERIC notify: a track change inside one
            // player never touches playback-status, so the narrow signal above
            // would leave the chip showing the previous album.
            artSig = curPlayer.connect("notify", () => { for (const r of artRefreshers) r() })
        }
        else { cancelGrace(); wasPlaying = false }
        for (const r of artRefreshers) r()
        onStatus()
    }
    return {
        id: "player",
        priority: 10,
        compact,
        expandMode: ISLAND_PLAYER,
        makeGhost: ({ hideArt }) => PlayerCompact({ ghost: true, hideArt }),
        // The compact's mini cover art FLIES into the player panel's 96px
        // artwork (ghost built at panel size, scaled down — stays sharp).
        flyer: {
            makeGhost: makeArtGhost,
            getSource: () => ((compact as any).artDa as Gtk.Widget) ?? null,
        },
        // The cover, with a music glyph UNDERNEATH it: the art paints opaque
        // over the glyph when there is one and paints nothing when there isn't,
        // so the fallback needs no visibility bookkeeping. (The empty wash the
        // compact draws is suppressed here — a grey square the size of an icon
        // says nothing; a music note says "something is playing".)
        indicator: () => {
            const stack = new Gtk.Overlay()
            stack.set_child(new Gtk.Image({ gicon: Icons.music, pixel_size: 16, css_classes: ["nd-icon"] }))
            const art = makeMiniArt()
            artRefreshers.push(() => (art as any).refresh())
            stack.add_overlay(art)
            return stack
        },
        watch: (cb) => { changed = cb; media.subscribe(rewire); rewire() },
        // The open player panel HOLDS liveness while a player exists (a grace
        // expiring under the open panel must not yank the compact); closing
        // the panel re-arbitrates (the engine listens on island-mode).
        isLive: () =>
            curPlayer?.playback_status === AstalMpris.PlaybackStatus.PLAYING ||
            grace !== null ||
            (!!curPlayer && status.island_mode === ISLAND_PLAYER),
    }
}

// ── Screen recording: danger dot + elapsed timer ─────────────────────────────
// THE live capture across the whole desktop: always on screen, whatever widgets
// the user installed, so nothing else needs to repeat the clock (the CC banner
// row that used to is gone — badge only now, see bar/StatusIndicators.tsx).
// Its expanded mode is RecordingIsland (clock + Stop), so the island answers for
// the capture end to end. It took two wrong destinations to get here, both
// user-caught: the workspace overview (a leftover from when the overview was the
// capsule's default identity — an unrelated surface answering the click,
// 2026-08-01) and then the Control Center, which made sense only while the CC
// banner held the only Stop; with that row gone, and the screenrecord widget
// placeable in the BAR ONLY, the click could land on a panel with nothing about
// the recording in it (2026-08-02). Fastest Stop is still the bar pill: one click.
function recActivity(): IslandActivity {
    // The elapsed label comes from core's recordingElapsed() — the shell-wide
    // stamp, shared with the CC tile and its detail page. Two reasons it cannot
    // be a local one: ghost twins only paint during morph frames and must show
    // the SAME time as the real compact (a stale "0:00" flashes through the
    // dissolve), and a surface built mid-capture would otherwise start counting
    // from zero.
    const labels: Gtk.Label[] = []
    let tick: number | null = null
    const syncLabels = () => { const v = recordingElapsed(); for (const l of labels) l.label = v }
    const ensureTick = () => {
        if (tick !== null) return
        tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!status.recording) { tick = null; return GLib.SOURCE_REMOVE }
            syncLabels()
            return GLib.SOURCE_CONTINUE
        })
    }
    // Ghost twins carry NO margins — snapshot_child already applies the
    // child's own margin offset, so margins on a twin shift the whole ghost
    // sideways mid-morph (the documented MorphRevealer gotcha; the battery
    // twin's 16px re-bit it 2026-07-20 pushing the % past the glass edge).
    const makeForm = (opts: { ghost?: boolean } = {}) => {
        // halign CENTER: symmetric pill resize mid-mutation (ActivityIsland).
        const box = opts.ghost
            ? new Gtk.Box({ spacing: 8 })
            : new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
        const dot = new Gtk.Box({ css_classes: ["island-rec-dot"], width_request: 8, height_request: 8, valign: Gtk.Align.CENTER })
        const time = new Gtk.Label({ css_classes: ["island-rec-time"], valign: Gtk.Align.CENTER, label: recordingElapsed() })
        labels.push(time)
        box.append(dot)
        box.append(time)
        return box
    }
    return {
        id: "rec",
        priority: 20,
        expandMode: ISLAND_RECORDING,
        compact: makeForm(),
        makeGhost: () => makeForm({ ghost: true }),
        // The same steady danger dot the compact and the CC badge use — a
        // capture has exactly one mark across the whole desktop.
        indicator: () => new Gtk.Box({ css_classes: ["island-rec-dot"], width_request: 8, height_request: 8 }),
        watch: (changed) => {
            status.connect("notify::recording", () => {
                if (status.recording) { syncLabels(); ensureTick() }
                changed()
            })
        },
        isLive: () => status.recording,
    }
}

// ── Battery critical: the auto-expand prototype ──────────────────────────────
// HIGH priority: discharging at/under 5% takes the compact AND opens the
// battery alert once per takeover. Hysteresis on the way out (UPower ticks are
// coarse — a 5%→6% wobble must not flap the island): clears on charging or
// above 7%. Desktops (no real battery) can never go live.
function batteryActivity(): IslandActivity {
    const bat = AstalBattery.get_default()
    const CRITICAL_AT = 0.05
    const CLEARS_ABOVE = 0.07
    let critical = false
    const evalCritical = () => {
        if (!batteryPresent() || bat!.charging) { critical = false; return }
        const f = batteryFrac()
        if (f <= CRITICAL_AT) critical = true
        else if (f > CLEARS_ABOVE) critical = false
        // Between the two thresholds: hold the previous state.
    }
    const labels: Gtk.Label[] = []
    const glyphs: Gtk.DrawingArea[] = []
    const syncForms = () => {
        const v = `${Math.round(batteryFrac() * 100)}%`
        for (const l of labels) l.label = v
        for (const g of glyphs) g.queue_draw()
    }
    // Ghost twins: NO margins (see recActivity's makeForm note). hideArt =
    // this twin rides a mode whose glyph FLIES (the flyer pair below): keep
    // the glyph's slot but paint it clear — the flying ghost owns those
    // pixels, two visible copies would diverge mid-flight.
    const makeForm = (opts: { ghost?: boolean, hideArt?: boolean } = {}) => {
        // halign CENTER: symmetric pill resize mid-mutation (ActivityIsland).
        const box = opts.ghost
            ? new Gtk.Box({ spacing: 8 })
            : new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
        const glyph = makeBatteryGlyph(16)   // icon box, same as the bar's battery pill
        glyph.valign = Gtk.Align.CENTER
        if (opts.hideArt) glyph.opacity = 0
        const pct = new Gtk.Label({ css_classes: ["island-battery-pct"], valign: Gtk.Align.CENTER })
        labels.push(pct)
        glyphs.push(glyph)
        box.append(glyph)
        box.append(pct)
        ;(box as any).glyph = glyph
        return box
    }
    const compact = makeForm()
    return {
        id: "battery",
        priority: 30,
        compact,
        expandMode: ISLAND_BATTERY,
        autoExpand: true,
        makeGhost: ({ hideArt }) => makeForm({ ghost: true, hideArt }),
        // The compact's glyph FLIES into the panel's glyph slot (same
        // continuity as media's cover art): ghost built at the PANEL size
        // (44, matching BatteryIsland's) and scaled down so it stays sharp.
        flyer: {
            makeGhost: () => makeBatteryGlyph(44),
            getSource: () => ((compact as any).glyph as Gtk.Widget) ?? null,
        },
        // The one Cairo battery glyph again, at bar icon size — its own fill
        // already carries the danger colour, so the chip needs nothing added.
        // Registered with the other glyphs so a level change repaints it (it
        // reads batteryFrac on DRAW and has no cadence of its own). Nothing
        // outranks 30 today, so a live battery always fronts and this chip never
        // actually shows — it exists so that stops being true silently.
        indicator: () => { const g = makeBatteryGlyph(16); glyphs.push(g); return g },
        watch: (changed) => {
            bat?.connect("notify", () => { evalCritical(); syncForms(); changed() })
            evalCritical(); syncForms()
        },
        isLive: () => critical,
    }
}

// ── Assistant: the "working pill", and the source while its panel is open ─────
// Priority 25 sits between recording (20) and battery-critical (30): a running
// assistant outranks ambient media + a capture, but a dying battery still wins.
// Liveness = a turn in flight (busy) OR its panel open (holds the compact as the
// morph source, like the player). Does NOT auto-expand via the engine flag —
// AgentService opens the island itself when a background turn FINISHES (the flag
// fires on TAKING the front, not on finishing); closing the island mid-turn does
// not cancel (isLive stays true while busy → the pill keeps working).
function agentActivity(): IslandActivity {
    const compact = AgentCompact()
    return {
        id: "agent",
        priority: 25,
        compact,
        expandMode: ISLAND_AGENT,
        makeGhost: () => AgentCompact({ ghost: true }),
        // `sparkles`, the same glyph the working pill wears, with a BADGE for a
        // turn that finished while the island could not show it. That mark is
        // the whole of the old "answer nobody saw" problem: not a mechanism of
        // its own, just a dot on an icon that was going to be there anyway.
        // Danger-coloured for a failed turn — an error and an answer are not
        // equally good news, and the badge is the only place that can say so
        // before you open it.
        indicator: () => {
            const wrap = new Gtk.Overlay()
            wrap.set_child(new Gtk.Image({ gicon: Icons.sparkles, pixel_size: 16, css_classes: ["nd-icon"] }))
            const badge = new Gtk.Box({
                css_classes: ["island-chip-badge"],
                width_request: 7, height_request: 7,
                halign: Gtk.Align.END, valign: Gtk.Align.START,
                visible: false,
            })
            wrap.add_overlay(badge)
            const syncBadge = () => {
                const u = agentService.unread
                badge.set_visible(u !== null)
                badge.set_css_classes(u === "error"
                    ? ["island-chip-badge", "error"]
                    : ["island-chip-badge"])
            }
            agentService.subscribe(syncBadge)
            syncBadge()
            return wrap
        },
        watch: (changed) => {
            agentService.subscribe(changed)
            // Re-arbitrate on island open/close too: opening the agent cold via
            // Super+A must mutate the compact to the agent form BEFORE the morph
            // reads its source (no dots-blink), and closing must revert.
            status.connect("notify::island-mode", changed)
            // Configuring a provider in Settings adds the chip THERE AND THEN,
            // which is the moment the feature becomes real to the user; without
            // this it would appear on the next shell reload and read as a bug.
            agentConfig.onChange(changed)
        },
        isLive: () => agentService.busy || status.island_mode === ISLAND_AGENT,
        // Configured = always reachable. Deliberately NOT part of isLive: an
        // always-live agent would outrank the music (25 > 10) and hold the
        // capsule for a session that never used it. An unread answer rides the
        // badge above, not the front — the chip is already on screen, so there
        // is nothing to announce by taking the capsule from whatever is running.
        isIndicated: () => agentService.configured(),
    }
}

// Dots FIRST: they are the priority-0 always-live activity, so they are both
// the compact stack's initial page and the capsule's resting form.
export function buildActivities(): IslandActivity[] {
    return [dotsActivity(), mediaActivity(), recActivity(), batteryActivity(), agentActivity()]
}
