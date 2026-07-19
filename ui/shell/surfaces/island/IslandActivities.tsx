import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalMpris from "gi://AstalMpris"
import AstalBattery from "gi://AstalBattery"
import status, { ISLAND_PLAYER, ISLAND_BATTERY } from "../../core/Status"
import * as media from "../../core/MediaService"
import { safeDisconnect } from "../../core/signals"
import { PlayerCompact } from "./PlayerIsland"
import { makeBatteryGlyph, batteryPresent, batteryFrac } from "../../common/BatteryGlyph"
import type { IslandActivity } from "./ActivityIsland"

// The island's ACTIVITIES — the concrete things the capsule can show live
// status for, declared as data for ActivityIsland's arbitration engine (see
// the IslandActivity interface there for the contract). Each activity OWNS
// its liveness policy: media its pause grace, battery its hysteresis. The
// engine only picks the highest-priority live one.
//
// Priorities (spacing of 10 leaves room to slot things between):
//   media 10 < recording 20 < battery-critical 30
// An active capture outranks ambient playback (it's the rarer, more
// consequential state); a critically-low battery outranks everything (it is
// ALSO the auto-expand prototype — the agent's "needs confirmation" will ride
// the same flag).

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
    const rewire = () => {
        safeDisconnect(curPlayer, sig); sig = null
        curPlayer = media.selectedPlayer()
        if (curPlayer) sig = curPlayer.connect("notify::playback-status", onStatus)
        else { cancelGrace(); wasPlaying = false }
        onStatus()
    }
    return {
        id: "player",
        priority: 10,
        compact,
        expandMode: ISLAND_PLAYER,
        makeGhost: ({ hideArt }) => PlayerCompact({ ghost: true, hideArt }),
        artSource: () => ((compact as any).artDa as Gtk.Widget) ?? null,
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

// ── Screen recording: pulsing dot + elapsed timer ────────────────────────────
// Mirrors the CC indicator (same status.recording source, same danger dot
// language) in the island's compact. No expanded mode of its own — Stop lives
// in the CC banner; clicking the capsule falls through to the overview.
function recActivity(): IslandActivity {
    // The elapsed label derives from one shared start timestamp: ghost twins
    // only paint during morph frames, and they must show the SAME time as the
    // real compact or the dissolve flashes a stale "0:00".
    let recStart = 0
    const labels: Gtk.Label[] = []
    let tick: number | null = null
    const fmt = () => {
        const s = Math.max(0, Math.floor((Date.now() - recStart) / 1000))
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
    }
    const syncLabels = () => { const v = fmt(); for (const l of labels) l.label = v }
    const ensureTick = () => {
        if (tick !== null) return
        tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!status.recording) { tick = null; return GLib.SOURCE_REMOVE }
            syncLabels()
            return GLib.SOURCE_CONTINUE
        })
    }
    const makeForm = () => {
        const box = new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16 })
        const dot = new Gtk.Box({ css_classes: ["island-rec-dot"], width_request: 8, height_request: 8, valign: Gtk.Align.CENTER })
        const time = new Gtk.Label({ css_classes: ["island-rec-time"], valign: Gtk.Align.CENTER, label: "0:00" })
        labels.push(time)
        box.append(dot)
        box.append(time)
        return box
    }
    return {
        id: "rec",
        priority: 20,
        compact: makeForm(),
        makeGhost: () => makeForm(),
        watch: (changed) => {
            status.connect("notify::recording", () => {
                if (status.recording) { recStart = Date.now(); syncLabels(); ensureTick() }
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
    const makeForm = () => {
        const box = new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16 })
        const glyph = makeBatteryGlyph(11)
        glyph.valign = Gtk.Align.CENTER
        const pct = new Gtk.Label({ css_classes: ["island-battery-pct"], valign: Gtk.Align.CENTER })
        labels.push(pct)
        glyphs.push(glyph)
        box.append(glyph)
        box.append(pct)
        return box
    }
    return {
        id: "battery",
        priority: 30,
        compact: makeForm(),
        expandMode: ISLAND_BATTERY,
        autoExpand: true,
        makeGhost: () => makeForm(),
        watch: (changed) => {
            bat?.connect("notify", () => { evalCritical(); syncForms(); changed() })
            evalCritical(); syncForms()
        },
        isLive: () => critical,
    }
}

export function buildActivities(): IslandActivity[] {
    return [mediaActivity(), recActivity(), batteryActivity()]
}
