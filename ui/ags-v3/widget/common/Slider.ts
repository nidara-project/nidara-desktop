import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

// Palette tokens are CSS variables; for Cairo we read the accent from ThemeManager
import Theme from "../../core/ThemeManager"

const TRACK_H  = 6   // px — track thickness
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

// Rounded-rectangle (capsule) path.
function roundRectPath(cr: any, x: number, y: number, w: number, h: number, r: number) {
    if (w <= 0 || h <= 0) return
    r = Math.min(r, w / 2, h / 2)
    cr.newPath()
    cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2)
    cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI)
    cr.arc(x + r,     y + r,     r, Math.PI,      1.5 * Math.PI)
    cr.closePath()
}

// Capsule spanning [m0,m1] along the main axis, centered on the cross axis (cc).
function capsuleMain(cr: any, m0: number, m1: number, cc: number, t: number, horiz: boolean) {
    const r = t / 2
    const len = Math.max(0, m1 - m0)
    if (horiz) roundRectPath(cr, m0, cc - r, len, t, r)
    else       roundRectPath(cr, cc - r, m0, t, len, r)
}

export type SliderOrientation = "horizontal" | "vertical"

export interface SliderOpts {
    min?: number
    max?: number
    value: number
    step?: number
    orientation?: SliderOrientation
    /** Draw the circular thumb (default true). false = bar/fill only. */
    thumb?: boolean
    onChange: (v: number) => void
    onValueChanged?: (v: number) => void   // every change (for label sync)
    onExtChange?: (cb: (v: number) => void) => (() => void)
    debounce?: number
    /** Commit onChange only when the interaction ends (drag release / scroll). */
    commitOnRelease?: boolean
    cssClasses?: string[]
    /** Main-axis size request (width for horizontal, height for vertical). */
    length?: number
    trackH?: number
    thumbR?: number
}

/**
 * makeSlider — the ONE slider for the whole shell (Cairo-drawn, horizontal or
 * vertical). Input is a custom GestureDrag + scroll (NOT a Gtk.Scale), so:
 *   • clicking the track jumps to that position,
 *   • grabbing the thumb never warps it (the old Gtk.Scale bug),
 *   • scroll adjusts by one step,
 *   • the thumb goes translucent while pressed.
 * Fill and thumb are drawn together, so they can never visually separate.
 */
export function makeSlider(opts: SliderOpts): Gtk.Widget {
    const { min = 0, max = 100, value, onChange, onExtChange, debounce = 0, commitOnRelease = false } = opts
    const horiz = (opts.orientation ?? "horizontal") !== "vertical"
    const thumb = opts.thumb ?? true
    const trackH = opts.trackH ?? TRACK_H
    const thumbR = opts.thumbR ?? THUMB_R
    const step = opts.step ?? (max - min) / 20
    const range = (max - min) || 1
    const crossMin = Math.max(thumb ? thumbR * 2 : trackH, 20)   // hit-area thickness

    let frac = Math.max(0, Math.min(1, (value - min) / range))
    let pressed = false
    const valueOf = () => min + frac * range

    const da = new Gtk.DrawingArea({
        can_target: true,
        focusable: true,
    })
    if (horiz) {
        da.hexpand = true; da.halign = Gtk.Align.FILL; da.valign = Gtk.Align.CENTER
        da.height_request = crossMin
        if (opts.length !== undefined) da.width_request = opts.length
    } else {
        da.vexpand = true; da.valign = Gtk.Align.FILL; da.halign = Gtk.Align.CENTER
        da.width_request = crossMin
        if (opts.length !== undefined) da.height_request = opts.length
    }
    if (opts.cssClasses?.length) opts.cssClasses.forEach(c => da.add_css_class(c))

    // ── Geometry helpers (use current allocation) ───────────────────────────────
    // With a thumb, inset the track by the thumb radius so the thumb stays inside the
    // widget at the ends. Thumbless (macOS-style capsule), the bar spans the full
    // length with rounded caps.
    const pad = thumb ? thumbR : 0
    const mainLen = () => horiz ? da.get_width() : da.get_height()
    const track   = () => Math.max(1, mainLen() - 2 * pad)
    const fracToMain = (f: number) => horiz ? pad + f * track() : pad + (1 - f) * track()
    const posToFrac  = (p: number) => {
        const pf = Math.max(0, Math.min(1, (p - pad) / track()))
        return horiz ? pf : 1 - pf
    }

    // ── Draw ────────────────────────────────────────────────────────────────────
    da.set_draw_func((_: any, cr: any, w: number, h: number) => {
        if (w <= 0 || h <= 0) return
        const L = horiz ? w : h
        const cc = (horiz ? h : w) / 2
        const trk = L - 2 * pad
        if (trk <= 0) return
        const tMain = fracToMain(frac)

        // Track
        const base = Theme.isDark ? 1 : 0
        cr.setSourceRGBA(base, base, base, Theme.isDark ? 0.18 : 0.14)
        capsuleMain(cr, pad, L - pad, cc, trackH, horiz); cr.fill()

        // Fill (accent)
        const [ar, ag, ab] = PALETTE[Theme.accentColor] ?? PALETTE.blue
        cr.setSourceRGBA(ar, ag, ab, 0.9)
        if (thumb) {
            // Capsule whose rounded end meets the thumb.
            if (horiz) capsuleMain(cr, pad, tMain, cc, trackH, true)
            else       capsuleMain(cr, tMain, L - pad, cc, trackH, false)
            cr.fill()
        } else {
            // Thumbless capsule: clip to the track shape and fill a rect so the fill's
            // far end follows the capsule's rounded cap (instead of going flat when short).
            cr.save()
            capsuleMain(cr, pad, L - pad, cc, trackH, horiz)
            cr.clip()
            const r = trackH / 2
            if (horiz) cr.rectangle(pad, cc - r, tMain - pad, trackH)
            else       cr.rectangle(cc - r, tMain, trackH, (L - pad) - tMain)
            cr.fill()
            cr.restore()
        }

        // Thumb
        if (thumb) {
            const tr = thumbR - 1
            const cx = horiz ? tMain : cc
            const cy = horiz ? cc : tMain
            cr.setSourceRGBA(0, 0, 0, 0.25); cr.newPath(); cr.arc(cx, cy + 1, tr, 0, 2 * Math.PI); cr.fill()
            cr.setSourceRGBA(1, 1, 1, pressed ? 0.55 : 0.95); cr.newPath(); cr.arc(cx, cy, tr, 0, 2 * Math.PI); cr.fill()
        }
    })

    // ── Commit machinery ────────────────────────────────────────────────────────
    let pendingId = 0
    const triggerChange = () => {
        if (debounce > 0) {
            if (pendingId) GLib.source_remove(pendingId)
            pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounce, () => {
                onChange(valueOf()); pendingId = 0; return GLib.SOURCE_REMOVE
            })
        } else {
            if (!pendingId) {
                pendingId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    onChange(valueOf()); pendingId = 0; return GLib.SOURCE_REMOVE
                })
            }
        }
    }
    const commit = () => {
        if (pendingId) { GLib.source_remove(pendingId); pendingId = 0 }
        onChange(valueOf())
    }
    // Apply a fraction from interaction: redraw + label, and (unless release-commit)
    // push the debounced onChange.
    const applyFrac = (f: number) => {
        const nf = Math.max(0, Math.min(1, f))
        if (nf === frac) return
        frac = nf
        da.queue_draw()
        opts.onValueChanged?.(valueOf())
        if (!commitOnRelease) triggerChange()
    }

    // ── Pointer input — grab the thumb without warping; click track to jump ──────
    const drag = new Gtk.GestureDrag()
    let startMain = 0
    let grabOffset = 0
    drag.connect("drag-begin", (_g: any, sx: number, sy: number) => {
        // Claim the sequence so the press/release doesn't bubble to a parent click
        // handler (e.g. a CC widget tile that would open its detail on release).
        _g.set_state(Gtk.EventSequenceState.CLAIMED)
        startMain = horiz ? sx : sy
        const tPos = fracToMain(frac)
        if (thumb && Math.abs(startMain - tPos) <= thumbR + 3) {
            grabOffset = startMain - tPos          // grabbed the thumb → keep it put
        } else {
            grabOffset = 0
            applyFrac(posToFrac(startMain))        // clicked the track → jump there
        }
        pressed = true; da.queue_draw()
    })
    drag.connect("drag-update", (_g: any, ox: number, oy: number) => {
        const off = horiz ? ox : oy
        applyFrac(posToFrac(startMain + off - grabOffset))
    })
    drag.connect("drag-end", () => { pressed = false; commit(); da.queue_draw() })
    da.add_controller(drag)

    // Scroll to adjust (up = increase, both axes).
    const scroll = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.BOTH_AXES })
    scroll.connect("scroll", (_c: any, dx: number, dy: number) => {
        const d = dy !== 0 ? dy : dx
        if (d === 0) return false
        applyFrac(frac + (d < 0 ? 1 : -1) * (step / range))
        commit()
        return true
    })
    da.add_controller(scroll)

    // Keyboard (accessibility).
    const keys = new Gtk.EventControllerKey()
    keys.connect("key-pressed", (_c: any, keyval: number) => {
        let nf = frac
        const s = step / range
        if (keyval === 0xff51 || keyval === 0xff54) nf = frac - s          // Left / Down
        else if (keyval === 0xff53 || keyval === 0xff52) nf = frac + s     // Right / Up
        else if (keyval === 0xff50) nf = 0                                  // Home
        else if (keyval === 0xff57) nf = 1                                  // End
        else return false
        applyFrac(nf); commit()
        return true
    })
    da.add_controller(keys)

    // Theme accent change → redraw.
    const themeSignalId = Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
    da.connect("unrealize", () => { try { Theme.disconnect(themeSignalId) } catch {} })

    // External value updates (ignored while the user is dragging).
    if (onExtChange) {
        const cleanup = onExtChange((v: number) => {
            if (pressed) return
            const f = Math.max(0, Math.min(1, (v - min) / range))
            if (Math.abs(f - frac) > 0.001) { frac = f; da.queue_draw(); opts.onValueChanged?.(valueOf()) }
        })
        da.connect("unrealize", cleanup)
    }

    // Prime the label.
    opts.onValueChanged?.(valueOf())

    return da
}

/** Horizontal convenience wrapper (back-compat: width_request → length). */
export function makeHSlider(opts: Omit<SliderOpts, "orientation" | "length"> & { width_request?: number }): Gtk.Widget {
    const { width_request, ...rest } = opts
    return makeSlider({ ...rest, orientation: "horizontal", length: width_request })
}
