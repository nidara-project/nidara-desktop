import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalMpris from "gi://AstalMpris"
import GdkPixbuf from "gi://GdkPixbuf"
import SquircleContainer from "../../common/SquircleContainer"
import { createSquirclePath } from "../../common/DrawingUtils"
import { PANEL_W } from "../../common/widget-kit"
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
//
// The WHEN (mutation policy, pause grace, click routing) lives in
// ActivityIsland.tsx — this file only renders.

// Glass recipe for the expanded container — exported so ActivityIsland's
// MorphRevealer paints its interpolated clone with the exact same params
// (same contract as WorkspaceOverview's WO_GLASS).
export const PLAYER_GLASS = { radius: 32, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

// ── Expanded mode surface ────────────────────────────────────────────────────

export default function PlayerIsland() {
    const panel = buildMediaDetailPanel(PANEL_W.full)
    const inner = new Gtk.Box({ margin_top: 14, margin_bottom: 14, margin_start: 18, margin_end: 18 })
    inner.append(panel)
    const squircle = SquircleContainer({
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

    // Morph handles (see common/MorphRevealer.ts). No morphDots — the ghost
    // dots only travel for the overview; the player content just fades in.
    ;(windowContent as any).morphContent = inner
    ;(windowContent as any).morphGlass = squircle
    return windowContent
}

// ── Compact form ─────────────────────────────────────────────────────────────

const ART = 20        // mini cover art (squircle-clipped, like the panel's 96px art)
const EQ_BARS = 3
const EQ_W = 13
const EQ_H = 13
// 10 fps, not a tick callback: the EQ damages the blurred bar layer on every
// frame it animates, and at 60 fps that's a session-long GPU cost for a 13px
// flourish (same class of waste as the 1 Hz bar re-blur guarded in
// widgets/media.ts). 10 fps still reads as motion at this size.
const EQ_FRAME_MS = 100

export function PlayerCompact(): Gtk.Widget {
    let player: any = null
    let playerSig: number | null = null
    let playing = false

    // Cover art — decode guarded by path identity (player "notify" fires at
    // 1 Hz while playing; see tech-debt #11C).
    let artPixbuf: GdkPixbuf.Pixbuf | null = null
    let loadedArt: string | null = null
    const artDa = new Gtk.DrawingArea({
        width_request: ART, height_request: ART,
        valign: Gtk.Align.CENTER,
    })
    artDa.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        cr.save()
        createSquirclePath(cr, 0, 0, w, h, 7, 3.2)
        if (artPixbuf) {
            cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0)
            cr.paint()
        } else {
            const c = Theme.chromeIsDark ? 1 : 0   // bar chrome — follows the pinned appearance
            cr.setSourceRGBA(c, c, c, 0.12)
            cr.fill()
        }
        cr.restore()
    })

    const title = new Gtk.Label({
        css_classes: ["bar-widget-label"],
        ellipsize: 3,
        max_width_chars: 24,
        valign: Gtk.Align.CENTER,
    })

    // EQ — three round-capped bars, animated only while PLAYING and mapped.
    let phase = 0
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
            const lvl = playing ? 0.35 + 0.65 * Math.abs(Math.sin(phase * EQ_SPEED[i] + i * 1.7)) : 0.28
            const x = i * (bw + gap) + bw / 2
            const top = h - Math.max(bw, lvl * h) + bw / 2
            cr.moveTo(x, h - bw / 2)
            cr.lineTo(x, top)
            cr.stroke()
        }
    })
    const ensureEqTimer = () => {
        if (eqTimer !== null || !playing || !eq.get_mapped()) return
        eqTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_FRAME_MS, () => {
            if (!playing || !eq.get_mapped()) { eqTimer = null; return GLib.SOURCE_REMOVE }
            phase += 0.35
            eq.queue_draw()
            return GLib.SOURCE_CONTINUE
        })
    }
    // Compact hidden (stack on the dots page) → unmapped → timer stops; map
    // while playing restarts it.
    eq.connect("map", ensureEqTimer)

    const box = new Gtk.Box({ spacing: 8, margin_start: 12, margin_end: 14 })
    box.append(artDa)
    box.append(title)
    box.append(eq)

    const loadArt = () => {
        const path = media.resolveCoverArt(player)
        if (path === loadedArt) return
        loadedArt = path
        if (path) {
            try { artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, ART, ART, false) }
            catch { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    const update = () => {
        const wasPlaying = playing
        playing = player?.playback_status === AstalMpris.PlaybackStatus.PLAYING
        title.label = player?.title || media.playerLabel(player)
        loadArt()
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
        if (artDa.get_mapped()) artDa.queue_draw()
        if (eq.get_mapped()) eq.queue_draw()
    })
    rewire()

    return box
}
