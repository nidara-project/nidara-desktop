// The marker in front of each install step: a check when done, a ring that fills
// with the step's own progress while active, an empty ring while pending.
//
// It replaced the text glyphs "✓ ● ○" (commandment 10: no characters as
// iconography — and a glyph's size and weight are whatever font answers for it).
// Drawn, so its ink is read from CSS through `get_color()`: the stylesheet decides
// the colour per state (`.installer-run-marker.is-*`), the Cairo only the shape.
// Same trick as the kit's selection check.

import Gtk from "gi://Gtk?version=4.0"
import { cairoDraw } from "../../lib/cairo-draw"

export type PhaseState = "done" | "active" | "pending"

export interface PhaseMarkerHandle {
  widget: Gtk.DrawingArea
  set(state: PhaseState, fraction: number): void
}

const SIZE = 16

export function PhaseMarker(): PhaseMarkerHandle {
  let state: PhaseState = "pending"
  let fraction = 0
  const da = new Gtk.DrawingArea({
    width_request: SIZE, height_request: SIZE,
    valign: Gtk.Align.CENTER,
    css_classes: ["installer-run-marker", "is-pending"],
  })
  da.set_can_target(false)
  da.set_draw_func(cairoDraw((widget: Gtk.DrawingArea, cr: any, w: number, h: number) => {
    const c = widget.get_color()
    const ink = (a: number) => cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha * a)
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 1.25
    cr.setLineWidth(1.75)
    cr.setLineCap(1)   // Cairo.LineCap.ROUND
    cr.setLineJoin(1)  // Cairo.LineJoin.ROUND
    if (state === "done") {
      ink(0.4); cr.arc(cx, cy, r, 0, 2 * Math.PI); cr.stroke()
      // Lucide's check (M20 6 9 17l-5-5), scaled into the ring.
      const k = r / 8
      ink(1)
      cr.moveTo(cx - 3.6 * k, cy + 0.2 * k)
      cr.lineTo(cx - 1 * k, cy + 2.8 * k)
      cr.lineTo(cx + 4 * k, cy - 2.8 * k)
      cr.stroke()
    } else if (state === "active") {
      ink(0.25); cr.arc(cx, cy, r, 0, 2 * Math.PI); cr.stroke()
      // Never an empty arc: an active step that has counted nothing yet still
      // has to look different from a pending one.
      ink(1)
      const f = Math.max(0.06, Math.min(1, fraction))
      cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * f)
      cr.stroke()
    } else {
      ink(0.6); cr.arc(cx, cy, r, 0, 2 * Math.PI); cr.stroke()
    }
  }))
  return {
    widget: da,
    set(s, f) {
      if (s === state && Math.abs(f - fraction) < 0.005) return
      if (s !== state) {
        da.remove_css_class(`is-${state}`)
        da.add_css_class(`is-${s}`)
      }
      state = s
      fraction = f
      da.queue_draw()
    },
  }
}
