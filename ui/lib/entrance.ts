import { Gtk } from "ags/gtk4"
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

        const start = GLib.get_monotonic_time()
        let tickId = 0
        tickId = widget.add_tick_callback(() => {
            if (done) return GLib.SOURCE_REMOVE
            const elapsed = (GLib.get_monotonic_time() - start) / 1000
            if (elapsed >= duration) {
                settle()
                return GLib.SOURCE_REMOVE
            }
            const p = easeEmphasized(elapsed / duration)
            widget.opacity = p
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

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 400, () => {
            if (!done && tickId) widget.remove_tick_callback(tickId)
            settle()
            return GLib.SOURCE_REMOVE
        })
    })
}
