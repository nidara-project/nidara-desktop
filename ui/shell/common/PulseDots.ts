// Shared "working" pulse — the three-dot typing indicator everyone already
// reads without being taught (iMessage, WhatsApp, every chat since), plus the
// bare phase for surfaces that breathe without their own drawing area.
// Lives in common/ because it is a painter, not a surface: anything that has to
// say "something is happening here, wait" can mount one.
//
// ONE DRIVER, REFCOUNTED. Every consumer shares a single phase and a single
// timer, held open only while at least one of them is active and mapped. Two
// timers would advance the phase twice as fast whenever the capsule glyph and
// the panel dots animate together, so the speed would depend on what happens to
// be on screen. It also keeps a MorphRevealer ghost in lockstep with its
// original for free: the twin subscribes to nothing and simply reads the phase
// during the morph's own per-frame redraw.
//
// TIMER DISCIPLINE (same as PlayerIsland's EQ): ~10 fps, never a frame clock —
// at this size motion reads fine and a 60 fps redraw is a session-long GPU cost
// for a 20px flourish. The driver stops itself the moment the last subscriber
// goes away, so an idle or hidden shell ticks nothing at all.
//
// Opacity, never scale: CSS transforms break GTK hit-testing (commandment 3),
// and alpha is what makes this read as breathing anyway.

import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Theme from "../core/ThemeManager"

const FRAME_MS = 100
const STEP = 0.45
const DOTS = 3
const DOT_R = 3
const GAP = 5
// One dot's worth of phase lag, so the three read as a travelling wave rather
// than a blink. A full 2π/3 opposes them completely and breaks the sense that
// they are one object.
const LAG = 0.9
const MIN_A = 0.22
const MAX_A = 0.85

let phase = 0
const subscribers = new Set<() => void>()
let driver: number | null = null

function ensureDriver() {
    if (driver !== null || subscribers.size === 0) return
    driver = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
        if (subscribers.size === 0) { driver = null; return GLib.SOURCE_REMOVE }
        phase += STEP
        subscribers.forEach(fn => fn())
        return GLib.SOURCE_CONTINUE
    })
}

/** Subscribe a redraw callback to the shared pulse. Returns an unsubscribe. */
function subscribe(fn: () => void): () => void {
    subscribers.add(fn)
    ensureDriver()
    return () => subscribers.delete(fn)
}

/** Current pulse alpha, for consumers that animate a widget's opacity instead
 *  of painting (the capsule's assistant glyph). `offset` shifts the phase so
 *  several elements can breathe out of step. */
export const pulseAlpha = (offset = 0): number =>
    MIN_A + (MAX_A - MIN_A) * (Math.sin(phase - offset) + 1) / 2

export const PULSE_W = DOTS * DOT_R * 2 + (DOTS - 1) * GAP
export const PULSE_H = DOT_R * 2

export interface PulseHandle {
    /** Start/stop this consumer. Idempotent — safe to call every reconcile. */
    setActive(active: boolean): void
}

/** Drive an arbitrary widget's opacity from the shared pulse (icons, glyphs). */
export function pulseOpacity(widget: Gtk.Widget, opts: { ghost?: boolean } = {}): PulseHandle {
    let active = false
    let stop: (() => void) | null = null

    const apply = () => { widget.opacity = pulseAlpha() }
    const sync = () => {
        const want = active && !opts.ghost && widget.get_mapped()
        if (want && !stop) stop = subscribe(apply)
        else if (!want && stop) { stop(); stop = null; widget.opacity = 1 }
    }
    // Mapping is the other half of the gate: the island HIDES rather than
    // destroys, so a widget can be "active" while invisible.
    widget.connect("map", sync)
    widget.connect("unmap", sync)

    return { setActive(next) { if (next === active) return; active = next; sync() } }
}

/** The three-dot indicator itself. */
export function makePulseDots(opts: { ghost?: boolean } = {}): PulseHandle & { widget: Gtk.Widget } {
    let active = false
    let stop: (() => void) | null = null

    const da = new Gtk.DrawingArea({
        width_request: PULSE_W,
        height_request: PULSE_H,
        valign: Gtk.Align.CENTER,
    })

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const c = Theme.chromeIsDark ? 1 : 0
        const cy = h / 2
        for (let i = 0; i < DOTS; i++) {
            // At rest this is a static row of dim dots — the indicator must look
            // deliberate, not broken, in the frame before the driver starts.
            cr.setSourceRGBA(c, c, c, active ? pulseAlpha(i * LAG) : MIN_A)
            cr.arc(DOT_R + i * (DOT_R * 2 + GAP), cy, DOT_R, 0, Math.PI * 2)
            cr.fill()
        }
    })

    const redraw = () => da.queue_draw()
    const sync = () => {
        const want = active && !opts.ghost && da.get_mapped()
        if (want && !stop) stop = subscribe(redraw)
        else if (!want && stop) { stop(); stop = null }
        da.queue_draw()
    }
    da.connect("map", sync)
    da.connect("unmap", sync)

    return { widget: da, setActive(next) { if (next === active) return; active = next; sync() } }
}
