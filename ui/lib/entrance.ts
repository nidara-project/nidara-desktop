import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

// The login screens' entrance, driven by the frame clock instead of by a CSS
// transition.
//
// ── WHY THIS IS NOT CSS ─────────────────────────────────────────────────────
// It was, and it worked everywhere except the one place it had to. Measured on a
// real lock, with the class added on a genuine frame and frames flowing:
//
//   +0ms    hero y=93.0   card y=614.0   frames=1     ← FROM state
//   (class added 2ms later)
//   +60ms   hero y=72.0   card y=594.0   frames=3     ← already final, 8ms on
//   +700ms  hero y=72.0   card y=594.0   frames=67
//
// The full 21px in under 8ms: GTK snapped to the end value and no transition ever
// registered. The same stylesheet interpolates correctly in an ordinary
// Gtk.Window on the same machine (538→533→522→518→517), so this is not the CSS.
//
// The likely reason is that under `ext-session-lock-v1` the surface gets NO frames
// for ~60ms and then the first two ticks arrive in one catch-up burst about 2ms
// apart, so the FROM state is laid out but never PAINTED — and a CSS transition
// with nothing painted to interpolate from is skipped. "Likely" is honest: what is
// measured is that it snaps, not why GTK decided to.
//
// Rather than keep guessing at that heuristic across lock/unlock cycles — the only
// way to test it — the animation is now ours. The frame clock is the one thing
// that surface demonstrably does provide.
//
// 🔑 It also removes the CSS transition's hidden precondition entirely: the FROM
// state is set BEFORE the widget is ever mapped, so the first paint is already the
// initial state, whatever the compositor does with its handshake.

/**
 * `cubic-bezier(0.2, 0, 0, 1)` — `$ease-emphasized`, the system's decelerate curve.
 * Solved rather than approximated so the two login screens move on exactly the
 * curve the design tokens name, and a future reader can compare them.
 */
function easeEmphasized(t: number): number {
    // x(u) and y(u) for a cubic Bézier with P0=(0,0), P1=(0.2,0), P2=(0,1), P3=(1,1).
    const bez = (u: number, a: number, b: number) => {
        const v = 1 - u
        return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
    }
    // Newton is unstable where the curve is near-vertical (this one starts steep in
    // y and flat in x), so bisect: 24 iterations is ~1e-7 on [0,1], far below a pixel.
    let lo = 0, hi = 1, u = t
    for (let i = 0; i < 24; i++) {
        u = (lo + hi) / 2
        if (bez(u, 0.2, 0) < t) lo = u; else hi = u
    }
    return bez(u, 0, 1)
}

export interface EntranceOpts {
    /**
     * Extra top margin at the start, closing to the widget's own value.
     *
     * ⚠️ NOT the travel when the widget is `valign: CENTER`: the margin also grows
     * the box and centring hands half of it back. Measured — 40 gives 21px on the
     * card, while the hero block (`valign: START`) keeps all of it and uses 21.
     */
    rise: number
    durationMs?: number
}

/**
 * Fade the widget in while it rises, once it is mapped.
 *
 * ⚠️ THE ANIMATION IS AN ENHANCEMENT, NEVER A GATE. The widget starts at
 * `opacity: 0`, so a frame clock that never ticks would leave an invisible login
 * card — being locked out by a flourish. A timeout lands the end state regardless;
 * the only casualty is the movement. Same rule the agent pointer follows.
 */
export function playEntrance(widget: Gtk.Widget, opts: EntranceOpts): void {
    const duration = opts.durationMs ?? 450

    let done = false
    let started = false
    let baseMargin = 0
    const settle = () => {
        if (done) return
        done = true
        widget.opacity = 1
        widget.margin_top = baseMargin
    }

    widget.connect("map", () => {
        // ⚠️ CAPTURE THE BASE MARGIN AT MAP, NOT AT BUILD. `NidaraClock` calls this
        // from its own constructor, and its HOST sets the real position afterwards
        // (`clockWidget.margin_top = 72` in Lock.ts / Greeter.ts). Reading it early
        // captured 0, so the animation would have landed the hero block 72px too
        // high — a silent, permanent layout bug dressed as an animation.
        if (started) return
        started = true
        baseMargin = widget.margin_top

        // The FROM state is set in `map`, which fires BEFORE the widget's first
        // draw — so the first painted frame is already the initial state, whatever
        // the compositor does with its handshake. That precondition is the whole
        // reason the CSS version failed here.
        widget.opacity = 0
        widget.margin_top = baseMargin + opts.rise

        // ⚠️ THE CLOCK STARTS AT THE FIRST FRAME, NOT AT `map`. Measured in a VM
        // (2026-08-10, cold and warm alike): the lock's main loop can be busy for
        // >300ms after `map`, and the first tick then arrives with the whole 450ms
        // budget already spent — the animation "ran" in one frame, straight to the
        // end state, exactly the snap this file exists to avoid. Wall time between
        // `map` and the first frame is startup cost, not animation.
        //
        // The FROM state still goes in `map` (above): that precondition is what the
        // CSS version could not satisfy, and it is untouched. Only the moment we
        // start COUNTING moves. A slow start now delays the animation instead of
        // eating it.
        let start = 0
        let watchdog = 0
        const armWatchdog = (ms: number) => {
            if (watchdog) GLib.source_remove(watchdog)
            watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                watchdog = 0
                if (!done && tickId) widget.remove_tick_callback(tickId)
                settle()
                return GLib.SOURCE_REMOVE
            })
        }

        let tickId = 0
        tickId = widget.add_tick_callback(() => {
            if (done) return GLib.SOURCE_REMOVE
            if (start === 0) {
                // First frame: this is t=0. Re-arm the safety net from here too, or
                // a late start would have it fire mid-animation and settle early.
                start = GLib.get_monotonic_time()
                armWatchdog(duration + 400)
                return GLib.SOURCE_CONTINUE
            }
            const elapsed = (GLib.get_monotonic_time() - start) / 1000
            if (elapsed >= duration) {
                if (watchdog) { GLib.source_remove(watchdog); watchdog = 0 }
                settle()
                return GLib.SOURCE_REMOVE
            }
            const t = elapsed / duration
            const p = easeEmphasized(t)
            // 🔑 POSITION AND ALPHA DO NOT SHARE A CURVE, and reusing one was a real
            // mistake here. `$ease-emphasized` is a strong decelerate: on the real
            // lock it put the card at 0.73 opacity by 150ms and 0.95 by 300, so the
            // fade was effectively over in the first sixth of the animation and the
            // remaining 300ms crawled from 0.73 to 1 — a stretch the eye cannot
            // resolve. The user's report was "I'm not sure the opacity changes at
            // all"; measured against the pixels it changed exactly proportionally
            // (alpha 0.060 / 0.161 / 0.222 for 0.27 / 0.73 / 1.00), so this was
            // never a rendering bug, it was the ramp.
            //
            // Alpha is LINEAR. Motion decelerating while alpha ramps evenly is the
            // usual split, and it is what makes the fade legible: at 150ms this is
            // 0.33 instead of 0.73.
            widget.opacity = t
            // Rounded: a fractional margin makes GTK re-round the whole layout every
            // frame, which shows up as the text jittering by a pixel as it travels.
            widget.margin_top = baseMargin + Math.round(opts.rise * (1 - p))
            return GLib.SOURCE_CONTINUE
        })

        // NIDARA_ENTRANCE_TRACE=1 nidara-lock — the greeter and the lockscreen are
        // the only surfaces in the DE that cannot be watched while they run, and
        // this animation has now been diagnosed twice from the log alone. Prints
        // the interpolation itself: distinct positions mean it ran, a single value
        // repeated means it snapped.
        if (GLib.getenv("NIDARA_ENTRANCE_TRACE")) {
            for (const at of [0, 60, 150, 300, 450, 700]) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, at + 5, () => {
                    const root = widget.get_root()
                    const b = root ? widget.compute_bounds(root) : null
                    const yy = b && b[0] ? b[1].origin.y.toFixed(1) : "?"
                    console.log(`[entrance] +${at}ms y=${yy} op=${widget.opacity.toFixed(2)} margin=${widget.margin_top}`)
                    return GLib.SOURCE_REMOVE
                })
            }
        }

        // The safety net, and it is a contract, not a fallback: a frame clock that
        // never ticks must still leave the card visible (it starts at opacity 0).
        // Armed from `map` for the "no frames ever" case; the first tick re-arms it.
        armWatchdog(duration + 400)
    })
}

/**
 * Fade a set of widgets out, then run `done` exactly once.
 *
 * ── WHY THE EXIT IS SHORT, AND WHY IT LEAVES THE WALLPAPER ALONE ────────────
 * There is no moment in which a "real" unlock transition could be seen. The
 * instant `Gtk4SessionLock.unlock()` is called the compositor tears our surface
 * down and the session is simply there — so an exit animation is not a transition,
 * it is a DELAY deliberately inserted before unlocking. macOS, iOS and GNOME all
 * cross-fade lock→desktop because they ARE the compositor; under
 * `ext-session-lock-v1` we are a client and only own the half that leaves.
 *
 * What makes the short version worth its latency is that the lockscreen paints the
 * SAME wallpaper as the desktop. Not "unless overridden": `ui/lib/wallpaper.ts`
 * RESERVES a `surfaces` block in its schema and `resolveWallpaper` reads it, but
 * nothing writes one and Settings does not expose it, so as of 2026-08-10 the two
 * images are always identical. That is the premise this exit is built on.
 *
 * ⚠️ WHOEVER IMPLEMENTS PER-SURFACE WALLPAPERS: re-check this. With a different
 * lockscreen image the held wallpaper stops being continuous with the desktop and
 * the final cut becomes the very thing the fade was bought to avoid — at which
 * point either the fade should be skipped when the two differ, or the wallpaper
 * should fade too. Do not add that check before it can happen; there is nothing to
 * detect today.
 *
 * So the caller fades the UI — card, clock, power bar — and holds the wallpaper: the final cut is then between our
 * wallpaper and the real desktop showing the same image, instead of between a full
 * lock screen and a desktop. The bar, the dock and the user's windows still pop in;
 * nothing we can do about that from here.
 *
 * 150ms is chosen to read as an acknowledgement that the password was accepted
 * rather than as waiting. Alpha is linear, for the reason documented above.
 *
 * ⚠️ `done` MUST run even if the frame clock stops — it is what unlocks the
 * session. A dropped callback here is a user locked out of their own machine, so
 * the timeout is not a nicety, it is the contract. Same reason the entrance can
 * never gate the card appearing.
 */
export function playExit(widgets: Gtk.Widget[], done: () => void, durationMs = 150): void {
    let finished = false
    const finish = () => {
        if (finished) return
        finished = true
        for (const w of widgets) w.opacity = 0
        done()
    }

    const driver = widgets[0]
    if (!driver) { finish(); return }

    const start = GLib.get_monotonic_time()
    let tickId = 0
    tickId = driver.add_tick_callback(() => {
        if (finished) return GLib.SOURCE_REMOVE
        const p = (GLib.get_monotonic_time() - start) / 1000 / durationMs
        if (p >= 1) { finish(); return GLib.SOURCE_REMOVE }
        for (const w of widgets) w.opacity = 1 - p
        return GLib.SOURCE_CONTINUE
    })

    // The contract, not a fallback: unlock happens on time whatever the clock does.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs + 250, () => {
        if (!finished && tickId) driver.remove_tick_callback(tickId)
        finish()
        return GLib.SOURCE_REMOVE
    })
}
