import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

// Palette tokens are CSS variables; for Cairo we read the accent from ThemeManager
import Theme from "../../core/ThemeManager"

const TRACK_H  = 6   // px — track height
const THUMB_R  = 9   // px — thumb radius (visual)

const PALETTE: Record<string, [number, number, number]> = {
    blue:   [0.00, 0.53, 1.00],
    teal:   [0.13, 0.56, 0.64],
    green:  [0.47, 0.72, 0.34],
    yellow: [0.95, 0.73, 0.29],
    orange: [0.91, 0.53, 0.23],
    red:    [0.93, 0.37, 0.36],
    pink:   [0.90, 0.37, 0.61],
    purple: [0.60, 0.34, 0.64],
    slate:  [0.44, 0.51, 0.59],
}

// Draw a filled horizontal pill from leftX to rightX, centered on cy, height h.
// Uses Cairo arc convention: angles clockwise in screen (y-down) coords.
function pillPath(cr: any, leftX: number, rightX: number, cy: number, h: number) {
    const r = h / 2
    const lc = leftX  + r  // left cap center X
    const rc = rightX - r  // right cap center X
    if (rc > lc) {
        // Normal pill: left semicircle (bottom→left→top), top line, right semicircle (top→right→bottom), bottom line
        cr.arc(lc, cy, r, Math.PI / 2, 3 * Math.PI / 2)    // left cap
        cr.arc(rc, cy, r, -Math.PI / 2, Math.PI / 2)        // right cap (Cairo adds top line)
    } else {
        // Too narrow: single circle at midpoint
        const mx = (leftX + rightX) / 2
        cr.arc(mx, cy, r, 0, 2 * Math.PI)
    }
    cr.closePath()
}

function drawSlider(cr: any, w: number, h: number, frac: number, trackH: number, thumbR: number) {
    const isDark = Theme.isDark
    const cy = h / 2
    const tx = thumbR                    // track left edge aligns with thumb center at min
    const tw = w - thumbR * 2           // track pixel width
    const thumbX = tx + frac * tw       // thumb center

    // ── Track background ─────────────────────────────────────────────
    const baseC = isDark ? 1 : 0
    cr.setSourceRGBA(baseC, baseC, baseC, isDark ? 0.18 : 0.14)
    cr.newPath()
    pillPath(cr, tx, tx + tw, cy, trackH)
    cr.fill()

    // ── Fill (accent) ─────────────────────────────────────────────────
    if (frac > 0.001) {
        const [ar, ag, ab] = PALETTE[Theme.accentColor] ?? PALETTE.blue
        cr.setSourceRGBA(ar, ag, ab, 0.9)
        cr.newPath()
        pillPath(cr, tx, thumbX, cy, trackH)
        cr.fill()
    }

    // ── Thumb ────────────────────────────────────────────────────────
    const tr = thumbR - 1
    cr.setSourceRGBA(0, 0, 0, 0.25)
    cr.newPath()
    cr.arc(thumbX, cy + 1, tr, 0, 2 * Math.PI)
    cr.fill()
    cr.setSourceRGBA(1, 1, 1, 0.95)
    cr.newPath()
    cr.arc(thumbX, cy, tr, 0, 2 * Math.PI)
    cr.fill()
}

export function makeHSlider(opts: {
    min?: number
    max?: number
    value: number
    step?: number
    onChange: (v: number) => void
    onValueChanged?: (v: number) => void   // called on every value change (for label sync)
    onExtChange?: (cb: (v: number) => void) => (() => void)
    debounce?: number
    cssClasses?: string[]
    width_request?: number
    trackH?: number   // track height in px (default 6)
    thumbR?: number   // thumb radius in px (default 9)
}): Gtk.Widget {
    const { min = 0, max = 100, value, onChange, onExtChange, debounce = 0 } = opts
    const trackH = opts.trackH ?? TRACK_H
    const thumbR = opts.thumbR ?? THUMB_R
    const step = opts.step ?? (max - min) / 20

    // ── Input layer: invisible Gtk.Scale with 0-px thumb ────────────
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        valign: Gtk.Align.FILL,
        draw_value: false,
        css_classes: ["cc-slider-scale-input"],
    })
    scale.set_range(min, max)
    scale.set_value(value)
    scale.set_increments(step, step * 4)

    // ── Visual layer: Cairo drawing (main child — controls height) ──
    const da = new Gtk.DrawingArea({
        hexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.CENTER,
        height_request: thumbR * 2,
        can_target: false,
    })
    da.set_draw_func((_, cr, w, h) => {
        const v = scale.get_value()
        const frac = (max - min) <= 0 ? 0 : (v - min) / (max - min)
        drawSlider(cr, w, h, frac, trackH, thumbR)
    })

    // ── Overlay: DrawingArea as base, Scale on top (invisible, input-only) ──
    const overlay = new Gtk.Overlay({ hexpand: true, valign: Gtk.Align.CENTER })
    overlay.set_child(da)           // da controls sizing
    overlay.add_overlay(scale)      // scale receives pointer events (opacity:0 via CSS)
    scale.halign = Gtk.Align.FILL
    scale.valign = Gtk.Align.FILL

    if (opts.width_request !== undefined) overlay.set_size_request(opts.width_request, -1)

    // Apply extra CSS classes to the overlay wrapper (e.g. cc-atomic-scale-native)
    if (opts.cssClasses?.length) {
        opts.cssClasses.forEach(c => overlay.add_css_class(c))
    }

    // ── onChange / debounce ──────────────────────────────────────────
    let ignoreUntil = 0
    let triggerChange: () => void

    if (debounce > 0) {
        let pendingId = 0
        triggerChange = () => {
            if (pendingId) GLib.source_remove(pendingId)
            pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounce, () => {
                onChange(scale.get_value())
                pendingId = 0
                return GLib.SOURCE_REMOVE
            })
        }
    } else {
        let pending = false
        triggerChange = () => {
            if (!pending) {
                pending = true
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    onChange(scale.get_value())
                    pending = false
                    return GLib.SOURCE_REMOVE
                })
            }
        }
    }

    scale.connect("value-changed", () => {
        ignoreUntil = GLib.get_monotonic_time() + 300_000
        da.queue_draw()
        opts.onValueChanged?.(scale.get_value())
        triggerChange()
    })

    const themeSignalId = Theme.connect("changed", () => da.queue_draw())
    overlay.connect("unrealize", () => { try { Theme.disconnect(themeSignalId) } catch {} })

    if (onExtChange) {
        const cleanup = onExtChange((v) => {
            if (GLib.get_monotonic_time() < ignoreUntil) return
            if (Math.abs(scale.get_value() - v) >= 1) {
                scale.set_value(v)
                da.queue_draw()
            }
        })
        overlay.connect("unrealize", cleanup)
    }

    return overlay
}
