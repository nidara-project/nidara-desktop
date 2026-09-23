// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * cairoDraw — every Gtk.DrawingArea draw function goes through this (#100).
 *
 * A draw function receives a `cairo.Context` that GJS wraps in a JS object. Until that
 * wrapper is garbage-collected the context stays alive, and with it everything it
 * references — the surface `Gdk.cairo_set_source_pixbuf` copies the icon into, patterns,
 * paths. The JS collector only runs on JS-heap pressure, and a draw function allocates
 * almost nothing on the JS side, so it can go a very long time without running while the
 * NATIVE heap fills with dead contexts.
 *
 * Measured 2026-09-15, headless cage, ten 128 px icons repainted while their size animates
 * (the dock's magnification): native [heap] 5 → 647 MB in 40 s without disposal, 5 → 14 MB
 * with `cr.$dispose()`. Live, three 30-second passes of the pointer over the dock took the
 * shell's heap 140 → 465 → 774 → 874 MB, which is tech-debt #100 / issue #305 (792 MB after
 * 21 h, with a JS heap of 42 MB).
 *
 * So the context is released when the function returns — in a `finally`, so an early
 * `return` or a throw releases it too. Do not keep `cr` (or anything that draws through it)
 * past the call: after `$dispose()` it is dead. `scripts/ci/cairo-dispose-check.mjs` fails
 * the build on a `set_draw_func` that does not go through here, and on an `append_cairo`
 * without a `$dispose()` in the same function.
 */
export function cairoDraw<A, W extends number, H extends number>(
    fn: (area: A, cr: any, width: W, height: H) => void,
): (area: A, cr: any, width: W, height: H) => void {
    return (area, cr, width, height) => {
        try {
            fn(area, cr, width, height)
        } finally {
            cr.$dispose()
        }
    }
}
