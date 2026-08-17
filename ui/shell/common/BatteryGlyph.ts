// Shared Cairo battery glyph — the ONE battery drawing in the shell (bar
// widget, CC tiles, island battery activity all render through here).
// Extracted from widgets/battery.ts when the island's battery-critical
// activity needed the same glyph (universal painters live in common/, not in
// a widget file another surface has to reach into).
//
// It is `assets/icons/hicolor/scalable/actions/battery.svg` REDRAWN IN CAIRO,
// not a battery of its own invention: same 24-unit viewBox, same path coords
// (body rect 1,6 18.5×12 r2 · terminal nub at x=23 from y=10 to y=14 · stroke 2),
// so it sizes and reads exactly like any other Lucide icon in the set. EDIT BOTH
// OR NEITHER — the SVG is what shows in Settings, the widget picker and the
// no-battery state, and a painter that has drifted from it is two batteries.
// The one deliberate deviation from the set: the ink spans the FULL 24 units
// instead of Lucide's 22-unit content box, spending the side padding on body
// width (and on the charge cavity, which is what actually has to stay legible
// at 16px). macOS does the same — its menu-bar battery is wider than its
// neighbours. The 1.5-unit gap before the nub is the floor: below it the two
// shapes antialias into one smudge at bar size.
// That is
// why the size argument is the ICON BOX in px — the literal equivalent of
// `Gtk.Image.pixel_size`, square, ink centred inside it. Sized any other way
// the bar capsule ends up wider than every icon widget's next to it.
//
// Fill ∝ exact charge; green while charging, danger-red at/below the low
// threshold (semantic status colors, NOT the theme accent — accent is
// reserved for selection). Chrome color follows the shell appearance pin.

import { Gtk } from "ags/gtk4"
import Theme from "../core/ThemeManager"
import * as Battery from "../core/BatteryService"
import { hexToFloatRgb } from "./DrawingUtils"
import { DANGER_HEX, SUCCESS_HEX } from "../../lib/status-colors"

/** A real battery device is present (false on desktops, where the display
 *  device exists but reports is_present = false). */
export const batteryPresent = Battery.present

/** Charge as a fraction 0..1. UPower reports 0..100; the conversion lives in
 *  core/BatteryService.ts, which is the shell's only door to UPower. */
export const batteryFrac = Battery.fraction

const RED   = hexToFloatRgb(DANGER_HEX)
const GREEN = hexToFloatRgb(SUCCESS_HEX)
export const LOW_THRESHOLD = 0.15

function roundRect(cr: any, x: number, y: number, w: number, h: number, r: number) {
    if (w <= 0 || h <= 0) return
    r = Math.min(r, w / 2, h / 2)
    cr.newPath()
    cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2)
    cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI)
    cr.arc(x + r,     y + r,     r, Math.PI,      1.5 * Math.PI)
    cr.closePath()
}

/** box = icon box in px — the same number you'd give a sibling `Gtk.Image` as
 *  `pixel_size`, so a battery next to Lucide icons requests the identical square
 *  and the capsule around it comes out the same width. The drawing is scaled
 *  from battery.svg's 24-unit grid (ink = 24×14 of those units, already centred
 *  in the viewBox), never stretched to the allocation.
 *  fill=true lets the DrawingArea fill its parent (e.g. the 48px icon circle) so the
 *  glyph is centred by the draw_func in the full allocation — robust against box quirks. */
export function makeBatteryGlyph(box: number, fill = false): Gtk.DrawingArea {
    const da = new Gtk.DrawingArea(fill
        ? { hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL }
        : { width_request: box, height_request: box, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const f = batteryFrac()
        // The bolt means "on AC", not "still filling" — so FULLY_CHARGED keeps it.
        // That is what AstalBattery's `charging` did (it was true at both states),
        // and the glyph is the one place that conflation was the RIGHT reading, so
        // it is spelled out here instead of inherited.
        const charging = batteryPresent() && (Battery.charging() || Battery.charged())
        const c = Theme.chromeIsDark ? 1 : 0   // shell skin (bar + CC) — follows appearance pin

        // SVG units → px. The 24-unit box is centred in the allocation; every
        // coordinate below is read straight off battery.svg.
        const u = (n: number) => (n * box) / 24
        const x0 = (w - box) / 2
        const y0 = (h - box) / 2

        // Chrome at 0.9, not the 0.5 this carried while the glyph was oversized:
        // the Lucide icons beside it stroke at full opacity (`.bar-left image`
        // has no attenuation), so at true icon scale a half-alpha 1.33px stroke
        // reads as a washed-out hairline — the battery looks SMALLER than
        // neighbours whose ink box is actually the same 22 units wide.
        const CHROME_A = 0.9

        // Body outline — rect 1,6 18.5×12 r2, stroke 2 straddling the path
        // (ink 0 → 20.5).
        roundRect(cr, x0 + u(1), y0 + u(6), u(18.5), u(12), u(2))
        cr.setLineWidth(u(2))
        cr.setSourceRGBA(c, c, c, CHROME_A)
        cr.stroke()

        // Terminal nub — the SVG's round-capped segment x=23, y 10→14, which is
        // exactly a filled 2×6 pill at 22,9 (no line-cap juggling needed).
        roundRect(cr, x0 + u(22), y0 + u(9), u(2), u(6), u(1))
        cr.setSourceRGBA(c, c, c, CHROME_A)
        cr.fill()

        // Proportional fill inside the body cavity (2,7 → 18.5,17), with a hair
        // of air so it never welds itself to the outline at small sizes.
        const gap = u(0.75)
        const innerW = u(16.5) - 2 * gap
        const fillW = Math.max(0, innerW * f)
        if (fillW > 0.5) {
            // Neutral fill at full alpha so the charge stays the brightest
            // element now that the chrome around it is at 0.9.
            let fr = c, fg = c, fb = c, fa = 1
            if (charging)          { ({ r: fr, g: fg, b: fb } = GREEN); fa = 0.95 }
            else if (f <= LOW_THRESHOLD) { ({ r: fr, g: fg, b: fb } = RED); fa = 0.95 }
            roundRect(cr, x0 + u(2) + gap, y0 + u(7) + gap, fillW, u(10) - 2 * gap, Math.max(0.5, u(1) - gap))
            cr.setSourceRGBA(fr, fg, fb, fa)
            cr.fill()
        }
    })
    return da
}
