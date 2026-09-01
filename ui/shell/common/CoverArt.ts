// Shared Cairo cover art — the ONE album-artwork painter in the shell (the three
// Control-Centre media tiles, the media detail panel, the Activity Island's compact
// player and the morph ghost all render through here).
//
// It was written six times. The drift that produced this file: three different
// placeholder alphas for the same empty slot, and only the island's two followed the
// appearance pin — the four on the Control-Centre side painted a FIXED WHITE, which
// on light chrome is white on white. The fix existed; with six copies it had nowhere
// to propagate. Universal painters live in common/, next to BatteryGlyph, which is
// the same story for the battery.
//
// It owns the two things every caller was re-deriving:
//   - the DECODE, guarded by art PATH identity. A player's "notify" fires for every
//     property it touches; re-decoding the PNG for a title change was the shell's
//     most expensive idle work (tech-debt #11C).
//   - the SUBSCRIPTION. It watches the MPRIS selection and the selected player's own
//     notify, so a caller wires nothing. It ALSO re-checks at draw time, because the
//     island's morph ghost paints only during morph frames and must carry the
//     current art into a flight it was not subscribed for.
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import { createSquirclePath } from "./DrawingUtils"
import { bindWhileRealized } from "../../lib/nidara-kit"
import Theme from "../core/ThemeManager"
import { safeDisconnect } from "../core/signals"
import * as media from "../core/MediaService"
import { INK } from "../../lib/tokens"

/** The media detail panel's artwork box, and the radius that goes with it. The
 *  island's compact art derives its own radius from this pair so the morph's two
 *  endpoints match (see PlayerIsland's ART_RADIUS) — which is what the comment
 *  "MUST match buildMediaDetailPanel's ART_SIZE" used to ask a human to maintain. */
export const PANEL_ART = 96
export const PANEL_ART_RADIUS = 14

export interface CoverArtOpts {
    /** Fixed px box — sets the widget's size request AND the decode size, so the
     *  artwork is painted at its native scale. Omit for a tile that fills whatever it
     *  is given (the 1×1 media tile); the art is then scaled per draw. */
    size?: number
    /** Squircle corner radius in px, or `"circle"` for a round tile. */
    shape: number | "circle"
    /** Where the art comes from. Defaults to the selected MPRIS player's. */
    getPath?: () => string | null
    /** Called whenever the artwork changes, with whether there IS any. For a caller
     *  that shows something else in its place — the 1×1 media tile puts a play glyph
     *  over the empty circle. Note this is false for a path that failed to DECODE
     *  too, which is the state that matters to such a caller. */
    onArt?: (hasArt: boolean) => void
}

export function makeCoverArt(opts: CoverArtOpts): Gtk.DrawingArea {
    const { size, shape, onArt } = opts
    const getPath = opts.getPath ?? (() => media.resolveCoverArt(media.selectedPlayer()))
    const decodeAt = size ?? PANEL_ART

    let pixbuf: GdkPixbuf.Pixbuf | null = null
    let loaded: string | null = null

    /** Returns true when the artwork actually changed — the caller of the redraw.
     *  `notify` is FALSE on the draw-time call: `onArt` flips another widget's
     *  visibility, and doing that from inside a snapshot queues a resize mid-draw. The
     *  subscription's own refresh runs on realize, before any draw, so a caller that
     *  passes `onArt` always hears about the art from there. */
    const sync = (notify: boolean): boolean => {
        const path = getPath()
        if (path === loaded) return false
        loaded = path
        pixbuf = null
        if (path) {
            try { pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, decodeAt, decodeAt, false) }
            catch { pixbuf = null }
        }
        if (notify) onArt?.(!!pixbuf)
        return true
    }

    const da = size !== undefined
        ? new Gtk.DrawingArea({ width_request: size, height_request: size })
        : new Gtk.DrawingArea({ hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        sync(false)

        // A squircle takes the whole allocation (the callers all hand it a square
        // box); a circle centres the largest square inside it, because the 1×1 tile
        // fills a cell it does not control.
        let x = 0, y = 0, tw = w, th = h
        cr.save()
        if (shape === "circle") {
            const d = Math.min(w, h)
            x = (w - d) / 2; y = (h - d) / 2; tw = d; th = d
            cr.arc(x + d / 2, y + d / 2, d / 2, 0, 2 * Math.PI)
        } else {
            createSquirclePath(cr, 0, 0, w, h, shape, 3.2)
        }

        if (pixbuf) {
            cr.clip()
            const art = (pixbuf.get_width() === tw && pixbuf.get_height() === th)
                ? pixbuf
                : pixbuf.scale_simple(tw, th, GdkPixbuf.InterpType.BILINEAR)
            if (art) {
                Gdk.cairo_set_source_pixbuf(cr, art, x, y)
                cr.paint()
            }
        } else {
            // Shell chrome, so the empty slot follows the appearance PIN rather than
            // the system mode — the same rule every other Cairo painter in common/
            // obeys (BatteryGlyph, PulseDots, SquircleContainer).
            const c = Theme.chromeIsDark ? 1 : 0
            cr.setSourceRGBA(c, c, c, INK.wash)
            cr.fill()
        }
        cr.restore()
    })

    // Realized lifetime, not a one-shot unrealize: the CC builds its tiles once and
    // hides them, so a plain unrealize-cleanup would leave the art frozen at whatever
    // was playing the first time the panel closed.
    bindWhileRealized(da, () => {
        let watched: any = null
        let sigId: number | null = null
        const refresh = () => { if (sync(true)) da.queue_draw() }
        const drop = () => {
            if (watched && sigId !== null) safeDisconnect(watched, sigId)
            watched = null; sigId = null
        }
        const rewire = () => {
            drop()
            watched = media.selectedPlayer()
            if (watched) sigId = watched.connect("notify", refresh)
            refresh()
        }
        rewire()
        const stop = media.subscribe(rewire)   // selection changes + async art arrivals
        // Rare (an appearance flip while music plays) but the empty slot is Cairo, so
        // it does not repaint itself when the stylesheet does.
        const themeSig = Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
        return () => { stop(); drop(); safeDisconnect(Theme, themeSig) }
    })

    return da
}
