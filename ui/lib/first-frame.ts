import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

/**
 * Add a CSS class once the widget's FROM state has actually been painted, so a
 * transition on that class has something to interpolate from.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Both login surfaces used `GLib.timeout_add(…, 16, …)` on `map`, with a comment
 * claiming it fired "on the next frame". A 16ms timeout is not a frame — it is
 * 16ms of wall clock, and the two only coincide when the widget is already being
 * drawn at 60Hz.
 *
 * On the LOCKSCREEN they are not the same thing at all. Under
 * `ext-session-lock-v1` the surface is mapped, then the compositor has to ack the
 * lock before anything reaches the screen, so `map` can precede the first real
 * frame by far more than 16ms. The class therefore landed BEFORE the initial
 * state had ever been rendered: GTK had no previous computed style to animate
 * from, and the card simply appeared. Reported from a real lock screen as "no
 * animation, or it arrives late, or there is none" (2026-08-10) — which is
 * exactly what a race looks like from the outside.
 *
 * A frame clock tick is the honest version of the same intent: it only fires when
 * frames are actually being produced for this widget.
 *
 * ⚠️ THE ANIMATION IS AN ENHANCEMENT, NEVER A GATE. `.greeter-card` is
 * `opacity: 0` until its class arrives, so a frame clock that never ticks would
 * mean an invisible login card — on the lockscreen, that is being locked out by a
 * flourish. Hence the fallback: if no frames come, the class goes on anyway and
 * the only thing lost is the animation. Same rule the agent pointer follows.
 */
export function revealOnFirstFrame(widget: Gtk.Widget, cssClass: string, fallbackMs = 500): void {
    let done = false
    let ticks = 0
    let tickId = 0
    const t0 = GLib.get_monotonic_time()

    const reveal = (how: string) => {
        if (done) return
        done = true
        widget.add_css_class(cssClass)
        // ⚠️ This line is not debug leftovers — keep it. The greeter and the
        // lockscreen are the only surfaces in the DE that cannot be watched while
        // they run, so the log is the only witness. It reports which path fired and
        // how long after `map`, which is exactly what distinguishes "the compositor
        // withheld frames" (frame, tens of ms) from "the frame clock never ran"
        // (fallback) — the question this whole file exists to answer. Measured on a
        // real lock: ext-session-lock-v1 acks ~60ms after the window is presented.
        console.log(`[entrance] ${cssClass} via ${how} +${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)}ms`)
    }

    tickId = widget.add_tick_callback(() => {
        // Tick callbacks run at the START of a frame cycle, so the first one is the
        // frame that paints the FROM state. Revealing on the SECOND means GTK has
        // rendered the initial style once and the transition has an origin.
        if (++ticks < 2) return GLib.SOURCE_CONTINUE
        reveal("frame")
        return GLib.SOURCE_REMOVE
    })

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, fallbackMs, () => {
        if (!done) {
            // Guard the id: a tick callback that already returned SOURCE_REMOVE must
            // not be removed again, and 0 is never a valid handler.
            if (tickId) widget.remove_tick_callback(tickId)
            reveal("fallback")
        }
        return GLib.SOURCE_REMOVE
    })
}
