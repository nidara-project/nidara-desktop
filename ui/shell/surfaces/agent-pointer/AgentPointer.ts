/**
 * Nidara — agent pointer overlay (the fake AI cursor).
 *
 * Draws the VISUAL for computer-use pointer actions: an accent-filled cursor
 * arrow with a glass "AI" badge that pops in at the real cursor's position,
 * travels to the target on a gently bowed ease-in-out path, ripples when the
 * real click lands, and lingers ~4s with a pulsing accent halo before fading.
 * The halo is load-bearing, not decoration: the moment the real injection
 * fires, the compositor warps the REAL cursor onto the landing point, and the
 * hardware cursor plane always paints ON TOP of layer surfaces — the fake
 * arrow gets covered and would read as "the AI cursor turned back into the
 * normal one". The ring around the tip is what keeps the AI presence legible.
 * The real input is injected by nidara-input underneath — this window
 * never receives nor produces input (empty input region, OVERLAY layer so it
 * stays visible over fullscreen windows).
 *
 * Two deliberate exceptions to shell conventions (documented in architecture.md):
 *  - It is its OWN window per monitor, not an overlay inside the bar's window:
 *    it must paint above the bar itself and above fullscreen surfaces.
 *  - Its visibility lives outside Status.ts (which governs mutually-exclusive
 *    USER overlays): module-level `isAgentPointerActive()` is surfaced through
 *    `dumpState.flags` instead (same precedent as the app grid).
 *
 * Cost at rest is ZERO: the window is created unmapped and only present()ed
 * while an action plays, then hidden again — an always-mapped empty layer once
 * cost 30–47% GPU (tech-debt §11); never regress that.
 *
 * Protocol (land→confirm — the visual never lies):
 *   agentPointerRun(kind, gx, gy, …)  → Promise resolves when the cursor LANDS
 *   agentPointerConfirm()             → the real action fired: ripple / drag glide
 *   agentPointerCancel(immediate?)    → aborted: fade out with no ripple
 *                                       (immediate = hard hide, for the kill switch)
 * If neither confirm nor cancel arrives (dead helper), a 3s orphan timeout
 * fades the cursor out anyway.
 */

import app from "ags/gtk4/app"
import { Gtk, Gdk } from "ags/gtk4"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Cairo from "gi://cairo"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import Theme from "../../core/ThemeManager"
import agentConfig from "../../core/AgentConfig"
import { t } from "../../core/i18n"
import { hexToFloatRgb } from "../../common/DrawingUtils"

type Kind = "click" | "rightclick" | "scroll" | "drag"
type Phase = "hidden" | "materialize" | "travel" | "landed" | "effect" | "dragGlide" | "idle" | "fadeout"

const FADE_IN_MS = 120
const FADE_OUT_MS = 280
const MATERIALIZE_MS = 160  // pop-in hold at the origin BEFORE travelling — lets the eye lock on
const POP_MS = 260          // scale-overshoot window of the pop-in (overlaps into early travel)
const RIPPLE_MS = 250
const DRAG_GLIDE_MS = 290   // ≈ the real injector's 24-step glide (cosmetic skew accepted)
const IDLE_MS = 4000        // linger after the last action — time to actually SEE the badge
const ORPHAN_MS = 3000
const IDLE_STRAY_PX = 24    // the user moved the real cursor this far during the linger → fade early
const IDLE_POLL_MS = 500    // cursorpos poll cadence during the linger (idle phase only)

// Cursor arrow: unit-height vertices (y down, hotspot at the tip = origin),
// classic pointer silhouette with a tail notch. Scaled by ARROW_H at draw time.
const ARROW_H = 22
const ARROW_SHAPE: [number, number][] = [
    [0.000, 0.000],
    [0.000, 0.800],
    [0.200, 0.655],
    [0.355, 1.000],
    [0.465, 0.952],
    [0.325, 0.610],
    [0.560, 0.610],
]
const BADGE_OFFSET_X = 16
const BADGE_OFFSET_Y = 22

// All live overlays (one per monitor) — the dumpState accessor ORs across them.
const instances = new Set<() => boolean>()

/** True while any monitor's agent pointer is visible (travelling, effecting,
 *  idling or fading). Surfaced as `dumpState.flags.agentPointer`. */
export function isAgentPointerActive(): boolean {
    for (const active of instances) if (active()) return true
    return false
}

export default function AgentPointer(gdkmonitor: Gdk.Monitor): Gtk.Window {
    // NB: no `resizable: false` — it pins the window to its natural size
    // (GTK's 200×200 default), which layer-shell then honors instead of
    // stretching to the 4 anchors, and everything paints off-surface
    // (measured live via `hyprctl layers`, 2026-07-12). LockOverlay is the
    // working reference: 4 anchors, no explicit size, no resizable pin.
    const win = new Gtk.Window({
        name: "nidara-agent-pointer",
        css_classes: ["nidara-agent-pointer-window", "nd-ignore"],
        application: app,
        focusable: false,
        can_focus: false,
        can_target: false,
    })
    ;(win as any).gdkmonitor = gdkmonitor

    const da = new Gtk.DrawingArea({ hexpand: true, vexpand: true, can_target: false })
    win.set_child(da)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "nidara-agent-pointer")
        Gtk4LayerShell.set_monitor(win, gdkmonitor)
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    } catch (e) {
        console.warn("[AgentPointer] layer-shell init failed (not on Wayland?):", e)
    }

    // Click-through: input passes to whatever is underneath. Set on every map —
    // a hide()/present() cycle can recreate the Wayland surface, so a one-shot
    // "realize" is not enough (unlike the always-mapped dock, DockAxis pattern).
    win.connect("map", () => {
        try {
            const surface = (win.get_native() as any)?.get_surface?.()
            surface?.set_input_region(new Cairo.Region())
        } catch (e) {
            console.error("[AgentPointer] input region failed:", e)
        }
    })
    // Deliberately NOT presented here: unmapped window = no Wayland surface =
    // zero GPU. present() happens per action, hide() after the fade-out.

    // ── Animation state (all mutated in the tick; the draw func only reads) ──
    let phase: Phase = "hidden"
    let kind: Kind = "click"
    let x = 0, y = 0                 // current cursor position (monitor-local logical px)
    let fromX = 0, fromY = 0         // travel origin
    let tx = 0, ty = 0               // travel target
    let cpX = 0, cpY = 0             // bowed bezier control point (a dead-straight glide reads robotic)
    let dropX = 0, dropY = 0         // drag release point
    let travelStart = -1, travelDur = 1
    let glideStart = -1
    let idleStart = 0
    let alpha = 0
    let pressed = false              // drag glide: cursor drawn "pressed" (Cairo scale 0.92)
    let ripple: { start: number, p: number, cx: number, cy: number, subtle: boolean } | null = null
    let bornUs = -1                  // pop-in start (frame-clock µs); -1 = not yet ticked
    let haloOn = false, haloT = 0    // landing halo: on from touchdown until hide, haloT in ms
    let idlePollAcc = 0, strayBusy = false
    let lastUs = 0
    let pending: ((v: string) => void) | null = null
    let orphanTimer = 0
    let tickId: number | null = null

    const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

    // The user always wins, also during the linger: if the REAL cursor strays
    // from the landing point while we idle, fade out early instead of leaving a
    // stale accent arrow next to the user's departing cursor. Best-effort — any
    // failure (no hyprctl, parse miss) just skips the check, never breaks the visual.
    const checkStray = () => {
        try {
            const proc = Gio.Subprocess.new(["hyprctl", "cursorpos"],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
            proc.communicate_utf8_async(null, null, (_p, res) => {
                strayBusy = false
                try {
                    const [, out] = proc.communicate_utf8_finish(res)
                    const m = String(out ?? "").match(/(-?\d+),\s*(-?\d+)/)
                    if (!m || phase !== "idle") return
                    const geo = gdkmonitor.get_geometry()
                    const cx = parseInt(m[1], 10) - geo.x
                    const cy = parseInt(m[2], 10) - geo.y
                    if (Math.hypot(cx - x, cy - y) > IDLE_STRAY_PX) phase = "fadeout"
                } catch { /* best-effort */ }
            })
        } catch { strayBusy = false }
    }

    const resolvePending = (v: string) => { if (pending) { const r = pending; pending = null; r(v) } }
    const clearOrphan = () => { if (orphanTimer) { GLib.source_remove(orphanTimer); orphanTimer = 0 } }

    const hardHide = (removeTick = true) => {
        clearOrphan()
        resolvePending("cancelled")
        if (removeTick && tickId !== null) { da.remove_tick_callback(tickId); tickId = null }
        phase = "hidden"
        alpha = 0
        ripple = null
        pressed = false
        bornUs = -1
        haloOn = false
        haloT = 0
        lastUs = 0
        try { win.set_visible(false) } catch (e) { console.error("[AgentPointer] hide failed:", e) }
    }

    const tick = (_w: Gtk.Widget, fc: Gdk.FrameClock): boolean => {
        const nowUs = fc.get_frame_time()
        const dtMs = lastUs ? Math.min(100, (nowUs - lastUs) / 1000) : 0
        lastUs = nowUs

        // Global alpha: eases in while acting, out during the fade-out phase.
        if (phase === "fadeout") alpha = Math.max(0, alpha - dtMs / FADE_OUT_MS)
        else alpha = Math.min(1, alpha + dtMs / FADE_IN_MS)

        if (haloOn) haloT += dtMs

        if (phase === "materialize") {
            if (bornUs < 0) bornUs = nowUs
            if (nowUs - bornUs >= MATERIALIZE_MS * 1000) { phase = "travel"; travelStart = -1 }
        } else if (phase === "travel") {
            if (travelStart < 0) travelStart = nowUs
            const tt = Math.min(1, (nowUs - travelStart) / (travelDur * 1000))
            // Ease-in-out along a gently bowed quadratic bezier — accelerate,
            // cruise, decelerate, like a hand would; never the robotic zip.
            const e = easeInOutCubic(tt), u = 1 - e
            x = u * u * fromX + 2 * u * e * cpX + e * e * tx
            y = u * u * fromY + 2 * u * e * cpY + e * e * ty
            if (tt >= 1) {
                phase = "landed"
                haloOn = true
                haloT = 0
                resolvePending("landed")
                // Orphan guard: helper died between land and confirm/cancel.
                orphanTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ORPHAN_MS, () => {
                    orphanTimer = 0
                    if (phase === "landed") phase = "fadeout"
                    return GLib.SOURCE_REMOVE
                })
            }
        } else if (phase === "dragGlide") {
            if (glideStart < 0) glideStart = nowUs
            // Linear, like the injector's evenly-spaced steps running concurrently.
            const gt = Math.min(1, (nowUs - glideStart) / (DRAG_GLIDE_MS * 1000))
            x = tx + (dropX - tx) * gt
            y = ty + (dropY - ty) * gt
            if (gt >= 1) {
                pressed = false
                ripple = { start: -1, p: 0, cx: dropX, cy: dropY, subtle: false }
                phase = "effect"
            }
        } else if (phase === "idle") {
            if (nowUs - idleStart >= IDLE_MS * 1000) phase = "fadeout"
            else {
                idlePollAcc += dtMs
                if (idlePollAcc >= IDLE_POLL_MS && !strayBusy) {
                    idlePollAcc = 0
                    strayBusy = true
                    checkStray()
                }
            }
        }

        if (ripple) {
            if (ripple.start < 0) ripple.start = nowUs
            ripple.p = Math.min(1, (nowUs - ripple.start) / (RIPPLE_MS * 1000))
            if (ripple.p >= 1) {
                ripple = null
                if (phase === "effect") { phase = "idle"; idleStart = nowUs; idlePollAcc = 0 }
            }
        }

        da.queue_draw()

        if (phase === "fadeout" && alpha <= 0) {
            tickId = null            // returning REMOVE detaches this callback
            hardHide(false)
            return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
    }

    const show = () => {
        try { win.present() } catch (e) { console.error("[AgentPointer] present failed:", e) }
        if (tickId === null) { lastUs = 0; tickId = da.add_tick_callback(tick) }
    }

    // ── Painter (colors resolved LIVE per frame — zero hardcoded accent) ─────
    let badgeLayout: Pango.Layout | null = null
    const getBadgeLayout = () => {
        if (!badgeLayout) {
            // The widget's own layout inherits the user's interface font — no
            // hardcoded family (first text-in-Cairo in the repo).
            badgeLayout = da.create_pango_layout(t("agentPointer.badge"))
            const fd = da.get_pango_context().get_font_description() ?? new Pango.FontDescription()
            fd.set_size(Math.round(8.5 * Pango.SCALE))
            fd.set_weight(Pango.Weight.BOLD)
            badgeLayout.set_font_description(fd)
        }
        return badgeLayout
    }

    const pillPath = (cr: any, px: number, py: number, pw: number, ph: number) => {
        const r = ph / 2
        cr.arc(px + pw - r, py + r, r, -Math.PI / 2, Math.PI / 2)
        cr.arc(px + r, py + r, r, Math.PI / 2, 3 * Math.PI / 2)
        cr.closePath()
    }

    da.set_draw_func((_widget: any, cr: any, _w: number, _h: number) => {
        if (phase === "hidden" || alpha <= 0) return
        const accent = hexToFloatRgb(Theme.accentPalette[Theme.accentColor].color)

        // Click ripple — an accent ring expanding from where the REAL action fired.
        if (ripple && ripple.p > 0 && ripple.p < 1) {
            const maxR = ripple.subtle ? 10 : 18
            const a0 = ripple.subtle ? 0.35 : 0.6
            cr.setSourceRGBA(accent.r, accent.g, accent.b, a0 * (1 - ripple.p) * alpha)
            cr.setLineWidth(2.5)
            cr.arc(ripple.cx, ripple.cy, maxR * ripple.p, 0, 2 * Math.PI)
            cr.stroke()
        }

        // Landing halo — the real cursor warps ONTO the fake arrow the moment
        // the injection fires, and the hardware cursor plane paints on top of
        // any layer surface: the arrow alone would read as "back to normal".
        // A pulsing accent ring around the tip keeps the AI presence legible
        // for the whole linger, real cursor on top or not.
        if (haloOn) {
            const hAlpha = Math.min(1, haloT / 250) * alpha
            const pulse = 0.5 + 0.5 * Math.sin(haloT / 300)
            const r = 13 + 2 * pulse
            cr.setSourceRGBA(accent.r, accent.g, accent.b, 0.12 * hAlpha)
            cr.arc(x, y, r + 5, 0, 2 * Math.PI)
            cr.fill()
            cr.setSourceRGBA(accent.r, accent.g, accent.b, (0.35 + 0.15 * pulse) * hAlpha)
            cr.setLineWidth(2)
            cr.arc(x, y, r, 0, 2 * Math.PI)
            cr.stroke()
        }

        // Arrow — accent fill, white outline, dark outer hairline (structural
        // strokes stay black/white, GlassBubble practice). Hotspot = tip.
        // Pop-in: born slightly oversized, settles to 1 — the eye locks on
        // BEFORE the travel starts (it materializes under the real cursor).
        const popAge = bornUs >= 0 ? Math.min(1, (lastUs - bornUs) / (POP_MS * 1000)) : 1
        const popScale = 1 + 0.3 * (1 - easeOutCubic(popAge))
        cr.save()
        cr.translate(x, y)
        cr.scale(popScale, popScale)
        if (pressed) cr.scale(0.92, 0.92)
        cr.setAntialias(2)  // GRAY
        cr.setLineJoin(1)   // ROUND — the tip's sharp angle would spike a miter join
        cr.moveTo(ARROW_SHAPE[0][0] * ARROW_H, ARROW_SHAPE[0][1] * ARROW_H)
        for (let i = 1; i < ARROW_SHAPE.length; i++)
            cr.lineTo(ARROW_SHAPE[i][0] * ARROW_H, ARROW_SHAPE[i][1] * ARROW_H)
        cr.closePath()
        // Outermost dark hairline, then white outline, then the fill covers each
        // stroke's inner half — leaving ~0.9px white + ~0.75px dark rings outside.
        cr.setSourceRGBA(0, 0, 0, 0.35 * alpha)
        cr.setLineWidth(3.25)
        cr.strokePreserve()
        cr.setSourceRGBA(1, 1, 1, 0.95 * alpha)
        cr.setLineWidth(1.75)
        cr.strokePreserve()
        cr.setSourceRGBA(accent.r, accent.g, accent.b, alpha)
        cr.fill()
        cr.restore()

        // Glass "AI" badge — offset pill under the arrow. More opaque than the
        // in-bar glass (~0.72): layer-shell surfaces here get no compositor blur.
        const layout = getBadgeLayout()
        const [tw, th] = layout.get_pixel_size()
        const padH = 6, padV = 2.5
        const bx = x + (pressed ? BADGE_OFFSET_X * 0.92 : BADGE_OFFSET_X)
        const by = y + (pressed ? BADGE_OFFSET_Y * 0.92 : BADGE_OFFSET_Y)
        const bw = tw + padH * 2
        const bh = th + padV * 2
        const dark = Theme.chromeIsDark
        pillPath(cr, bx, by, bw, bh)
        const base = dark ? 0 : 1
        cr.setSourceRGBA(base, base, base, 0.72 * alpha)
        cr.fillPreserve()
        cr.setSourceRGBA(1, 1, 1, (dark ? 0.22 : 0.65) * alpha)
        cr.setLineWidth(1)
        cr.stroke()
        cr.setSourceRGBA(dark ? 1 : 0.1, dark ? 1 : 0.1, dark ? 1 : 0.1, 0.95 * alpha)
        cr.moveTo(bx + padH, by + padV)
        PangoCairo.show_layout(cr, layout)
    })

    // ── Public surface (methods hung off the window, DockCore precedent) ─────

    /** Start (or re-aim) an action's travel. Coordinates are GLOBAL logical px;
     *  converted here against the monitor's geometry, re-read per run. Resolves
     *  when the cursor lands (BEFORE any effect — the land→confirm protocol). */
    ;(win as any).agentPointerRun = (
        runKind: Kind, gx: number, gy: number,
        gx2?: number, gy2?: number, fbx?: number, fby?: number,
    ): Promise<string> => {
        const geo = gdkmonitor.get_geometry()
        clearOrphan()
        resolvePending("superseded")   // a burst re-aims without an intermediate fade
        ripple = null
        pressed = false
        kind = runKind
        tx = gx - geo.x
        ty = gy - geo.y
        if (runKind === "drag") {
            dropX = (gx2 ?? gx) - geo.x
            dropY = (gy2 ?? gy) - geo.y
        }
        const wasHidden = phase === "hidden"
        if (wasHidden) {
            // Born WHERE the real cursor is (the injector will warp from there);
            // without a baseline, appear at the target and just fade in.
            x = fbx !== undefined ? fbx - geo.x : tx
            y = fby !== undefined ? fby - geo.y : ty
            alpha = 0
            bornUs = -1
            show()
        }
        // else: already visible from a previous action — continue from (x, y).
        fromX = x
        fromY = y
        const dist = Math.hypot(tx - fromX, ty - fromY)
        // Deliberate, hand-like pace: ~0.3s for a nudge, ~1s across the screen.
        travelDur = Math.min(1000, 280 + dist * 0.5)
        // Bow the path perpendicular to the straight line (capped) — see cpX/cpY.
        const bow = Math.min(36, dist * 0.10)
        if (dist > 1) {
            cpX = (fromX + tx) / 2 - ((ty - fromY) / dist) * bow
            cpY = (fromY + ty) / 2 + ((tx - fromX) / dist) * bow
        } else {
            cpX = (fromX + tx) / 2
            cpY = (fromY + ty) / 2
        }
        travelStart = -1
        glideStart = -1
        haloOn = false
        haloT = 0
        idlePollAcc = 0
        // A fresh appearance holds at the origin first (pop-in, MATERIALIZE_MS)
        // so the eye can lock on; a chained action re-aims and travels directly.
        phase = wasHidden ? "materialize" : "travel"
        return new Promise<string>(resolve => { pending = resolve })
    }

    /** The real action fired: play the effect (ripple / scroll pulse / drag glide). */
    ;(win as any).agentPointerConfirm = () => {
        if (phase !== "landed") return
        clearOrphan()
        if (kind === "drag") {
            pressed = true
            glideStart = -1
            phase = "dragGlide"
        } else {
            ripple = { start: -1, p: 0, cx: x, cy: y, subtle: kind === "scroll" }
            phase = "effect"
        }
    }

    /** The action was aborted: fade out with NO ripple (the visual never lies).
     *  `immediate` hard-hides instead — kill switch / lockscreen. */
    ;(win as any).agentPointerCancel = (immediate = false) => {
        if (phase === "hidden") return
        clearOrphan()
        resolvePending("cancelled")
        if (immediate) hardHide()
        else phase = "fadeout"
    }

    ;(win as any).isAgentPointerActive = () => phase !== "hidden"
    instances.add(() => phase !== "hidden")

    // Kill switch: revoking computer-control (IPC disableComputerControl, the bar
    // indicator, Settings → AI, Super+Shift+Esc) vanishes the cursor instantly.
    agentConfig.onChange(() => {
        if (!agentConfig.allowComputerControl) (win as any).agentPointerCancel(true)
    })

    return win
}
