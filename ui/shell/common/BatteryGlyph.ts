// Shared Cairo battery glyph — the ONE battery drawing in the shell (bar
// widget, CC tiles, island battery activity all render through here).
// Extracted from widgets/battery.ts when the island's battery-critical
// activity needed the same glyph (universal painters live in common/, not in
// a widget file another surface has to reach into).
//
// Fill ∝ exact charge; green while charging, danger-red at/below the low
// threshold (semantic status colors, NOT the theme accent — accent is
// reserved for selection). Chrome color follows the shell appearance pin.

import { Gtk } from "ags/gtk4"
import AstalBattery from "gi://AstalBattery"
import Theme from "../core/ThemeManager"
import { hexToFloatRgb } from "./DrawingUtils"
import { DANGER_HEX, SUCCESS_HEX } from "../../lib/status-colors"

const bat = AstalBattery.get_default()

/** A real battery device is present (false on desktops, where the display
 *  device exists but reports is_present = false). */
export const batteryPresent = () => !!bat && bat.is_present

/** Charge as a fraction 0..1 (AstalBattery.percentage is a fraction per the
 *  GI docs, NOT 0..100). */
export const batteryFrac = () => (batteryPresent() ? Math.max(0, Math.min(1, bat!.percentage)) : 0)

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

/** gh = glyph height in px; the body is ~2× as wide plus a small terminal nub.
 *  fill=true lets the DrawingArea fill its parent (e.g. the 48px icon circle) so the
 *  glyph is centred by the draw_func in the full allocation — robust against box quirks. */
export function makeBatteryGlyph(gh: number, fill = false): Gtk.DrawingArea {
    const gw = Math.round(gh * 2.0)
    const da = new Gtk.DrawingArea(fill
        ? { hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL }
        : { width_request: gw + 3, height_request: gh + 2, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const f = batteryFrac()
        const charging = batteryPresent() && bat!.charging
        const c = Theme.chromeIsDark ? 1 : 0   // shell skin (bar + CC) — follows appearance pin
        const stroke = gh >= 24 ? 1.6 : 1.2
        const r = gh * 0.28

        // Glyph centred in the allocation.
        const nubW = Math.max(1.5, gw * 0.05)
        const bodyW = gw - nubW - 1
        const x0 = (w - gw) / 2
        const y0 = (h - gh) / 2

        // Body outline.
        roundRect(cr, x0 + stroke / 2, y0 + stroke / 2, bodyW - stroke, gh - stroke, r)
        cr.setLineWidth(stroke)
        cr.setSourceRGBA(c, c, c, 0.5)
        cr.stroke()

        // Terminal nub on the right.
        const nubH = gh * 0.42
        roundRect(cr, x0 + bodyW, y0 + (gh - nubH) / 2, nubW, nubH, nubW * 0.4)
        cr.setSourceRGBA(c, c, c, 0.5)
        cr.fill()

        // Proportional fill.
        const pad = stroke + 1.5
        const innerW = bodyW - 2 * pad
        const fillW = Math.max(0, innerW * f)
        if (fillW > 0.5) {
            let fr = c, fg = c, fb = c, fa = 0.85
            if (charging)          { ({ r: fr, g: fg, b: fb } = GREEN); fa = 0.95 }
            else if (f <= LOW_THRESHOLD) { ({ r: fr, g: fg, b: fb } = RED); fa = 0.95 }
            roundRect(cr, x0 + pad, y0 + pad, fillW, gh - 2 * pad, Math.max(0.5, r - pad))
            cr.setSourceRGBA(fr, fg, fb, fa)
            cr.fill()
        }
    })
    return da
}
