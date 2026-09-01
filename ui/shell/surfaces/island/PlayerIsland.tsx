import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import SquircleContainer, { GLASS_SHADOW } from "../../common/SquircleContainer"
import { RADIUS } from "../../../lib/tokens"
import { PANEL_W } from "../../common/widget-kit"
import { makeCoverArt, PANEL_ART, PANEL_ART_RADIUS } from "../../common/CoverArt"
import { buildMediaDetailPanel } from "../../widgets/media"
import * as media from "../../core/MediaService"
import Theme from "../../core/ThemeManager"
import { safeDisconnect } from "../../core/signals"

// The Activity Island's PLAYER mode — both halves of the media activity:
//
//   - PlayerIsland(): the EXPANDED surface (a registered island mode, morphs
//     out of the capsule like the overview). The content is the same rich
//     media panel the bar pill expansion and the CC detail already share
//     (widgets/media.ts buildMediaDetailPanel: artwork, title/artist, seek
//     slider, transport, source selector) wrapped in the island's glass.
//   - PlayerCompact(): the capsule's COMPACT form while media is live —
//     mini cover art + ellipsized title + a small animated EQ (design agreed
//     2026-07-19). Self-syncing from MediaService, same lifetime model as the
//     other bar capsule content (long-lived, never disconnected).
//   - PlayerCompact({ ghost: true }) / makeArtGhost(): twins for the morph's
//     continuity tracks (MorphRevealer sourceGhost / art MorphPair). Ghost
//     twins run NO timers of their own — the EQ phase is module-shared and
//     advanced only by the real compact, so a ghost painted mid-morph shows
//     bit-identical bars for free (and an idle ghost never damages the bar).
//
// The WHEN (mutation policy, pause grace, click routing) lives in
// ActivityIsland.tsx — this file only renders.

// Glass recipe for the expanded container — exported so ActivityIsland's
// MorphRevealer paints its interpolated clone with the exact same params
// (same contract as WorkspaceOverview's WO_GLASS).
export const PLAYER_GLASS = { radius: RADIUS.xl, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

// ── Expanded mode surface ────────────────────────────────────────────────────

export default function PlayerIsland() {
    const panel = buildMediaDetailPanel(PANEL_W.full)
    const inner = new Gtk.Box({ margin_top: 16, margin_bottom: 16, margin_start: 20, margin_end: 20 })
    inner.append(panel)
    const squircle = SquircleContainer({
        shadow: GLASS_SHADOW,
        child: inner,
        n: PLAYER_GLASS.n,
        radius: PLAYER_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: PLAYER_GLASS.border,
    })
    const windowContent = new Gtk.Box({
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true,
    })
    windowContent.append(squircle)

    // Morph handles (see common/MorphRevealer.ts). morphArt is the landing
    // slot of the cover-art MorphPair: the compact's mini art flies into it.
    ;(windowContent as any).morphContent = inner
    ;(windowContent as any).morphGlass = squircle
    ;(windowContent as any).morphArt = (panel as any).artDa ?? null
    return windowContent
}

// ── Compact form ─────────────────────────────────────────────────────────────

const ART = 20        // mini cover art (squircle-clipped, like the panel's 96px art)
// Compact art corner radius = the panel's radius scaled to the compact size, so
// the art MorphPair's ghost (a 96px twin, uniformly scaled) matches BOTH
// endpoints — a fixed 7 here made the frame-0 swap visibly round the corners.
// Both ends of that ratio come from common/CoverArt, which paints them; this used
// to carry a hand-maintained "MUST match buildMediaDetailPanel's ART_SIZE".
const ART_RADIUS = PANEL_ART_RADIUS * ART / PANEL_ART
const EQ_BARS = 3
const EQ_W = 13
const EQ_H = 13
// 10 fps, not a tick callback: the EQ damages the blurred bar layer on every
// frame it animates, and at 60 fps that's a session-long GPU cost for a 13px
// flourish (same class of waste as the 1 Hz bar re-blur guarded in
// widgets/media.ts). 10 fps still reads as motion at this size.
const EQ_FRAME_MS = 100

// Module-shared EQ phase: advanced ONLY by real (non-ghost) compacts, read by
// every EQ draw — a morph ghost's bars stay in perfect sync with the capsule's
// without running a second timer.
let eqPhase = 0

export function PlayerCompact(opts: {
    ghost?: boolean
    /** Ghost twins for a mode with an art MorphPair keep the art SLOT (layout
     *  must match the real compact) but paint it transparent — the flying art
     *  ghost owns those pixels; two visible copies would diverge mid-flight. */
    hideArt?: boolean
} = {}): Gtk.Widget {
    let player: any = null
    let playerSig: number | null = null
    let playing = false

    // Cover art — decode guarded by path identity (player "notify" fires at
    // 1 Hz while playing; see tech-debt #11C).
    const artDa = makeCoverArt({ size: ART, shape: ART_RADIUS })
    artDa.valign = Gtk.Align.CENTER
    artDa.opacity = opts.hideArt ? 0 : 1

    const title = new Gtk.Label({
        css_classes: ["bar-widget-label"],
        ellipsize: 3,
        max_width_chars: 24,
        valign: Gtk.Align.CENTER,
    })

    // EQ — three round-capped bars, animated only while PLAYING and mapped.
    let eqTimer: number | null = null
    const eq = new Gtk.DrawingArea({
        width_request: EQ_W, height_request: EQ_H,
        valign: Gtk.Align.CENTER,
    })
    // Per-bar speeds desynced so the motion reads organic, not metronomic.
    const EQ_SPEED = [1.0, 1.35, 0.8]
    eq.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const c = Theme.chromeIsDark ? 1 : 0
        const bw = 3
        const gap = (w - EQ_BARS * bw) / (EQ_BARS - 1)
        cr.setSourceRGBA(c, c, c, 0.75)
        cr.setLineWidth(bw)
        cr.setLineCap(1)   // round caps, same as the resource rings
        for (let i = 0; i < EQ_BARS; i++) {
            const lvl = playing ? 0.35 + 0.65 * Math.abs(Math.sin(eqPhase * EQ_SPEED[i] + i * 1.7)) : 0.28
            const x = i * (bw + gap) + bw / 2
            const top = h - Math.max(bw, lvl * h) + bw / 2
            cr.moveTo(x, h - bw / 2)
            cr.lineTo(x, top)
            cr.stroke()
        }
    })
    const ensureEqTimer = () => {
        if (opts.ghost || eqTimer !== null || !playing || !eq.get_mapped()) return
        eqTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_FRAME_MS, () => {
            if (!playing || !eq.get_mapped()) { eqTimer = null; return GLib.SOURCE_REMOVE }
            eqPhase += 0.35
            eq.queue_draw()
            return GLib.SOURCE_CONTINUE
        })
    }
    // Compact hidden (stack on the dots page) → unmapped → timer stops; map
    // while playing restarts it. (Ghost twins never tick: the morph's own
    // per-frame redraw repaints them reading the shared phase.)
    if (!opts.ghost) eq.connect("map", ensureEqTimer)

    // Ghost twins carry NO margins: MorphRevealer anchors them on the REAL
    // page's content bounds (compute_bounds excludes margins), and
    // snapshot_child already applies the child's own margin offset — margins
    // on the twin double that offset and shift the whole ghost 12px right
    // (EQ past the glass edge mid-morph + a visible re-seat when the
    // contraction lands; user-caught 2026-07-19).
    // 16px side air = the bar capsule family standard (dots, clock, search all
    // use 16) — anything tighter reads cramped next to its siblings. halign
    // CENTER so mid-mutation the resizing pill condenses symmetrically around
    // the content instead of dragging it with the moving left edge (see the
    // compact-page rule in ActivityIsland.tsx).
    const box = opts.ghost
        ? new Gtk.Box({ spacing: 8 })
        : new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
    box.append(artDa)
    box.append(title)
    box.append(eq)

    const update = () => {
        const wasPlaying = playing
        playing = player?.playback_status === media.PlaybackStatus.PLAYING
        title.label = player?.title || media.playerLabel(player)
        if (playing !== wasPlaying) {
            ensureEqTimer()
            eq.queue_draw()   // paused: settle to the static low bars now
        }
    }

    const rewire = () => {
        safeDisconnect(player, playerSig); playerSig = null
        player = media.selectedPlayer()
        if (player) playerSig = player.connect("notify", update)
        update()
    }
    media.subscribe(rewire)
    // Rare (appearance flip while music plays) but the Cairo chrome color must
    // follow it, same as every other bar painter.
    Theme.connect("changed", () => {
        if (eq.get_mapped()) eq.queue_draw()   // the art follows it inside makeCoverArt
    })
    rewire()

    // Source handle for the art MorphPair (ActivityIsland wires it).
    ;(box as any).artDa = artDa
    return box
}

// ── Self-syncing cover art ───────────────────────────────────────────────────
// A DrawingArea of `size` px that paints the CURRENT track's cover, clipped to
// the squircle, with the empty wash when there is none. It reads the player on
// DRAW rather than subscribing: its one caller (the morph's traveling twin)
// paints at moments that already have their own redraw cadence, and must not be
// left holding a stale bitmap.
// The traveling twin of the cover art: natural size = the PANEL slot, scaled DOWN
// by the morph toward the compact's 20px slot, so it stays sharp the whole flight
// and matches both endpoints (the compact's radius is derived from the panel's,
// see ART_RADIUS). It is literally the panel's own painter — that it re-checks the
// art path at DRAW time is what lets the close flight carry the current track, with
// no per-tick wiring (see common/CoverArt).
export const makeArtGhost = (): Gtk.Widget =>
    makeCoverArt({ size: PANEL_ART, shape: PANEL_ART_RADIUS })
