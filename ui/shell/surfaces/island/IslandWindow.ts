import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import { MorphRevealer } from "../../common/MorphRevealer"
import { setVisibleRect } from "../../common/VisibleRegion"
import { acquireFocusGrab, releaseFocusGrab } from "../../common/FocusGrab"
import status from "../../core/Status"
import inputYield from "../../core/InputYield"

// The Activity Island's OWN layer surface — the one documented exception to
// "overlays live inside the Bar's window" (skill commandment #5).
//
// WHY. Hyprland's layer blur difumina what is BEHIND a surface, once, at
// composite time. Everything painted inside one GTK window lands in one buffer,
// so an island inside the bar's window could never blur the bar capsules it
// grows over: Cairo has no backdrop-filter, and at the default 0.05 glass alpha
// those capsules read through it sharp and untouched. A SEPARATE surface on a
// HIGHER layer level is composited after the bar, so the blur pass samples it.
//
// VERIFIED, not assumed (2026-07-25, Hyprland 0.55.4): a throwaway layer surface
// on OVERLAY with `ignore_alpha = 0.01` blurred the bar beneath it at glass
// alphas 0.05 / 0.20 / 0.38 alike. `new_optimizations` does not restrict blur
// sampling to the background, and `xray` is off.
//
// WHY NOT A POPOVER (the other candidate, as Settings' dropdowns do it): popups
// are blurred under `popups_ignorealpha = 0.30`, a DIFFERENT knob from a layer's
// `ignore_alpha`, and it cannot be lowered without Hyprland blurring the popup's
// own drop shadow into a halo. A popover island would have to floor its glass at
// 0.38 (as `NidaraTheme.popoverAlpha` does) and would stop honouring the user's
// opacity setting. A layer keeps 0.05.
//
// THE COMPACT CAPSULE LIVES HERE TOO — and that is the whole point of the
// design, not an implementation detail. The island is meant to be ONE object
// that changes shape: the capsule's pill inflates into the expanded container
// and deflates back. With the capsule on the bar's surface and the expanded
// modes here, the morph spanned two surfaces, which meant (a) a cross-window
// coordinate bridge in MorphRevealer and (b) both surfaces painting glass over
// the same pixels mid-morph, so their blurs stacked and the transition showed a
// visible seam (user-caught 2026-07-26). One surface owns the shape end to end:
// no bridge, no stacked blur, and `compute_bounds` just works.
//
// The bar still owns the capsule's GEOMETRY (Bar.tsx builds the row and hands it
// over) — the row reuses `.bar-centerbox`/`.bar-center` so the 8px top margin and
// 40px row height come from the same CSS the bar uses, not a duplicated constant.

const NAMESPACE = "nidara-island"

export interface IslandWindowHandle {
    win: Gtk.Window
    /** Mount the compact capsule's row (always present) and the mode revealers
     *  (revealed on demand). Both end up in ONE surface — see the header.
     *  `hitTargets` are the capsule and the indicator chips THEMSELVES, not the
     *  row: the row spans the whole monitor width to centre them, and stamping
     *  that into the input region would swallow every click meant for the bar's
     *  own capsules underneath. It is a GETTER, re-read on every stamp — which
     *  of them can be hit changes with the island (see ActivityIsland). */
    mount: (capsuleRow: Gtk.Widget, hitTargets: () => Gtk.Widget[], revealers: MorphRevealer[]) => void
    /** Root the revealers are anchored against — their `margin_top` is measured
     *  relative to this, exactly as it used to be against the bar's overlay. */
    root: () => Gtk.Widget
    /** Take modality for an open island mode. There is no per-mode distinction to
     *  make: a compositor focus grab carries keyboard AND pointer either way, so an
     *  ambient mode gets dismissal and a keyboard mode gets keys from the same call.
     *  (The old `needsKeyboard` argument existed only to pick EXCLUSIVE on the
     *  layer-shell fallback, which died with the catchers.)
     *
     *  `peers` are other windows of ours that must stay clickable THROUGH the
     *  grab — in practice the bar's, so capsule-to-capsule switching stays one
     *  click. They are not a nicety: a press outside the whitelist is delivered to
     *  the grabbed surface and then dismisses, so it never reaches what you
     *  clicked (see common/FocusGrab.ts).
     *
     *  Returns whether the compositor grab took. There is no second mechanism to
     *  fall back to, so a false is not a degrade — it is a surface nothing can
     *  dismiss, and the caller is expected to say so loudly. */
    setModal: (open: boolean, peers: (Gtk.Window | null)[]) => boolean
    /** Re-stamp the click-through mask: the capsule always, plus whatever mode
     *  is currently revealed. */
    updateInputRegion: () => void
    /** Follow the bar in and out of sight (fullscreen hide, lock). Unmapping
     *  also drops the surface's blur pass entirely. */
    setShown: (shown: boolean) => void
    /** Re-assert our layer level. Hyprland appends a surface to its layer list
     *  when the level is (re)set, so whenever the BAR moves to OVERLAY too (bar
     *  overlay mode) it would land after us and cover the island. */
    raise: () => void
    /** Follow the BAR's top edge. We sit at `exclusive_zone = -1` so nothing can
     *  displace us — which is right until something reserves space ABOVE the bar
     *  (Hyprland's config-error bar), because the bar respects that reservation
     *  and we do not, leaving the capsule floating above the row it belongs to.
     *  Rather than model who reserves what, mirror where the bar actually IS
     *  (`HyprlandState.layerTop`, which documents the full mechanism). 0 in the
     *  normal case, so this changes nothing until something pushes the bar. */
    setTopOffset: (px: number) => void
}

export function IslandWindow(gdkmonitor: Gdk.Monitor): IslandWindowHandle {
    const monGeo = gdkmonitor.get_geometry()
    const win = new Gtk.Window({
        name: NAMESPACE,
        application: app,
        css_classes: ["nidara-island-window"],
        default_width: monGeo.width,
        default_height: monGeo.height,
        visible: false,
    })

    const root = new Gtk.Overlay({ valign: Gtk.Align.FILL, vexpand: true })
    // Gtk.Overlay needs a main child; an empty box keeps the overlay children's
    // alignment contract identical to the bar's master overlay. It catches
    // nothing — the input region below only ever covers what is painted.
    root.set_child(new Gtk.Box())
    win.set_child(root)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, NAMESPACE)
        // OVERLAY, one level above the bar's TOP: the level ordering is what
        // guarantees we are composited after the bar, which is what makes the
        // blur see it. Same-level ordering would depend on surface creation
        // order — not something to hang the effect on.
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        for (const edge of [Gtk4LayerShell.Edge.TOP, Gtk4LayerShell.Edge.LEFT,
                            Gtk4LayerShell.Edge.RIGHT, Gtk4LayerShell.Edge.BOTTOM])
            Gtk4LayerShell.set_anchor(win, edge, true)
        // -1 = ignore every exclusive zone, ours and everyone else's, so the
        // surface is EXACTLY the monitor rect. Anything else and the bar's own
        // 40px reservation would push us down by 40 — and since the capsule now
        // lives here, that would move the capsule off the bar row.
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
        Gtk4LayerShell.set_monitor(win, gdkmonitor)
    } catch (e) {
        console.error("[IslandWindow] LayerShell failed:", e)
    }

    let hitTargets: () => Gtk.Widget[] = () => []
    let revealers: MorphRevealer[] = []
    // How far the whole surface is pushed down to stay level with the bar — see
    // setTopOffset. Normally 0; everything below that converts between
    // root-relative and monitor-relative coordinates has to add it.
    let topOffset = 0

    // Our ownership token for the compositor focus grab that IS this surface's
    // modality, 0 when we hold none — see setModal and common/FocusGrab.ts. A token rather
    // than a boolean because the BAR grabs the same single slot: it can evict us
    // between our own open and close, and a release we no longer own would take
    // down ITS grab.
    let grabToken = 0

    const updateInputRegion = () => {
        const surface = win.get_native()?.get_surface()
        if (!surface?.set_input_region) return
        const region = new Cairo.Region()
        // Yielded for an agent action (core/InputYield): fully click-through, capsule
        // included. This surface spans the WHOLE monitor, so leaving the panel's own
        // rect stamped would still eat every synthetic click aimed at whatever sits
        // behind the Assistant — the exact clicks the yield exists to let through.
        if (inputYield.active) {
            surface.set_input_region(region)
            // A yield changes who gets the CLICKS, not what is painted — the island
            // is still on screen, so its blur region is computed the same way.
            updateVisibleRegion()
            win.queue_draw()
            return
        }
        // compute_bounds against the root, NOT get_allocation(): the capsule is
        // nested (root > row > centre box > capsule) and a child's allocation is
        // relative to its parent, so an allocation would land the rect in the
        // wrong place. Bounds are root-relative whatever the depth.
        const add = (w: Gtk.Widget | null) => {
            if (!w?.get_visible() || !w.get_mapped()) return
            const [ok, b] = w.compute_bounds(root)
            if (!ok || b.get_width() <= 1 || b.get_height() <= 1) return
            // @ts-ignore  (same untyped Cairo.Region call as Bar.tsx)
            region.unionRectangle({
                x: Math.round(b.get_x()), y: Math.round(b.get_y()),
                width: Math.round(b.get_width()), height: Math.round(b.get_height()),
            })
        }
        // The capsule must stay clickable at all times — it is a bar control that
        // happens to be painted here. Same for whichever indicator chips are
        // currently revealed.
        for (const t of hitTargets()) add(t)
        for (const r of revealers) add(r)
        surface.set_input_region(region)
        updateVisibleRegion()
        win.queue_draw()   // input regions are double-buffered: apply on next commit
    }

    // ── Blur cost: what this surface actually PAINTS ────────────────────────────
    //
    // This layer is the worst offender of the three (`tech-debt.md` §46): it is the
    // monitor rect, it is blurred, and at rest it shows a ~300px capsule. Hyprland
    // charges layer blur by the surface's BOX, so every repaint of every window
    // anywhere on screen pays for all of it.
    //
    // 🔑 The rule is the opposite of the dock's, and the difference is the morph.
    // The dock can declare its rect in every state because its silhouette is known
    // before it paints. Here the expanded modes arrive through a MorphRevealer, and
    // a widget that was just made visible has NO allocation until the next layout
    // pass — so a region computed at open time would describe the capsule alone
    // while the mode paints far outside it, and the mode would be SCISSORED AWAY
    // for as long as it stayed open. (That one-frame `0,0 0x0` is documented in
    // §46: it is normal GTK, it shows up in control builds too.)
    //
    // So: declare ONLY while resting as the compact capsule, and hand the whole
    // surface back the instant anything is revealed or still animating. The resting
    // state is ~all of the time and is exactly the expensive one; a mode being open
    // is transient, the user is looking at it, and it is the risky half. The
    // ordering is safe because we send the clear BEFORE the frame that paints the
    // opening mode commits — Wayland applies surface state on commit, in request
    // order, on the same connection.
    // The two paddings are wildly different on purpose, and the asymmetry is the
    // whole safety argument.
    //
    // VERTICAL is where the money is: this rect trades a 1440px-tall box for the
    // bar row, and nothing else paints above or below it at rest (the chip badge
    // overlaps its glyph, `--nidara-shadow-sm` spreads ≤3px). So keep it tight.
    //
    // HORIZONTAL is where the MOTION is, and where a tight rect would be a bug
    // factory: the capsule is centred, so anything that changes its width slides
    // it sideways, and one of those paths re-stamps 400ms LATE (`Bar.tsx` →
    // `onBackgroundChanged`, because a chip appearing does not resize the glass
    // and so never fires the `resize` hook). Late is harmless for an input region
    // — a click arrives a moment late — but a visible region that lags is a chip
    // that IS NOT DRAWN for 400ms. A pad wider than any such shift (three chips
    // ≈ 150px) makes the whole class of late stamps a non-event, and it costs
    // very little: the cut that matters is the height.
    const BLUR_PAD_X = 200
    const BLUR_PAD_Y = 16
    let lastBlurKey = ""
    const updateVisibleRegion = () => {
        const surface = win.get_native()?.get_surface()
        if (!surface) return
        const set = (key: string, rect: { x: number, y: number, width: number, height: number } | null) => {
            if (key === lastBlurKey) return
            lastBlurKey = key
            setVisibleRect(surface, rect)
        }
        // `get_visible()` alone is not enough on the way out: a closing revealer is
        // still visible until its final tick, and tickId is the only thing that
        // says "still moving".
        if (revealers.some(r => r.get_visible() || r.tickId !== null)) { set("open", null); return }

        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const w of hitTargets()) {
            if (!w?.get_visible() || !w.get_mapped()) continue
            const [ok, b] = w.compute_bounds(root)
            if (!ok || b.get_width() <= 1 || b.get_height() <= 1) continue
            x0 = Math.min(x0, b.get_x());                  y0 = Math.min(y0, b.get_y())
            x1 = Math.max(x1, b.get_x() + b.get_width());  y1 = Math.max(y1, b.get_y() + b.get_height())
        }
        // Nothing measurable (first frames, capsule hidden): the un-optimised
        // surface is always the safe answer.
        if (!isFinite(x0)) { set("none", null); return }

        // Clamp to the surface, which is the monitor rect MINUS any top offset —
        // a rect past the buffer is intersected away, and an empty intersection
        // cancels the element, i.e. the island disappears.
        const surfH = Math.round(monGeo.height - topOffset)
        const x = Math.max(0, Math.round(x0) - BLUR_PAD_X)
        const y = Math.max(0, Math.round(y0) - BLUR_PAD_Y)
        const width = Math.min(monGeo.width - x, Math.round(x1 - x0) + BLUR_PAD_X * 2)
        const height = Math.min(surfH - y, Math.round(y1 - y0) + BLUR_PAD_Y * 2)
        if (width <= 0 || height <= 0) { set("none", null); return }
        set(`rest:${x},${y},${width},${height}`, { x, y, width, height })
    }

    // What the island actually COVERS, monitor-relative — capsule plus whichever
    // mode is revealed, which is exactly what `updateInputRegion` stamps.
    //
    // This exists for the AGENT, not for layout. The Assistant lives in this island
    // and was happily clicking controls that sit UNDERNEATH it: the click lands
    // (the yield makes the surface click-through), but it happens where the user
    // cannot see it, which reads as the assistant doing something behind their
    // back. Reporting the rect lets it close the island first — see `setIsland`.
    // Bounds are root-relative and the surface is exactly the monitor rect
    // (exclusive_zone -1 above), so root-relative IS monitor-relative here.
    const occupiedRect = (): { x: number, y: number, w: number, h: number, monitor: string } | null => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        const add = (w: Gtk.Widget | null) => {
            if (!w?.get_visible() || !w.get_mapped()) return
            const [ok, b] = w.compute_bounds(root)
            if (!ok || b.get_width() <= 1 || b.get_height() <= 1) return
            x0 = Math.min(x0, b.get_x());              y0 = Math.min(y0, b.get_y())
            x1 = Math.max(x1, b.get_x() + b.get_width()); y1 = Math.max(y1, b.get_y() + b.get_height())
        }
        for (const t of hitTargets()) add(t)
        for (const r of revealers) add(r)
        if (!isFinite(x0)) return null
        // The connector name (DP-1, …) so a consumer on a multi-monitor setup can
        // tell whether this rect is even on the output it is clicking — the numbers
        // are monitor-LOCAL and would otherwise silently compare across screens.
        return {
            // + topOffset: bounds are root-relative, and root-relative equals
            // monitor-relative only while the surface starts at the monitor's top
            // corner. Forget it and the agent is told the island is higher than it
            // is, which is exactly the "clicking under the island" bug this exists
            // to prevent.
            x: Math.round(x0), y: Math.round(y0 + topOffset),
            w: Math.round(x1 - x0), h: Math.round(y1 - y0),
            monitor: gdkmonitor.get_connector() ?? "",
        }
    }
    // Stamped on the window so app.ts can reach it the same way it reaches the
    // dock's app-grid state — by scanning `windows` for the named surface.
    ;(win as any).occupiedRect = occupiedRect

    return {
        win,
        root: () => root,
        mount: (row, targets, mounted) => {
            hitTargets = targets
            revealers = mounted
            // A mode's rect enters the input region from the layout pass that
            // gives the revealer an allocation — NOT from the turn that revealed
            // it, where it still has none. Before the focus grab that gap was
            // covered by the catcher's hand-written full-screen rect; without it,
            // a click inside a freshly opened mode fell through to whatever was
            // behind, which the compositor reads as a press outside the grab and
            // dismisses. That is the "island doesn't take mouse input when it
            // opens" symptom, and it lasted the whole 300ms morph.
            for (const r of mounted) r.onAllocated = updateInputRegion
            root.add_overlay(row)
            for (const r of mounted) root.add_overlay(r)
            // Present once, and stay mapped: the capsule is permanent furniture
            // now. Deferred like the bar's own present so the first frame has a
            // settled layout, and the region stamped after it so the capsule is
            // clickable from the start.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                win.present()
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                    updateInputRegion(); return GLib.SOURCE_REMOVE
                })
                return GLib.SOURCE_REMOVE
            })
        },
        setModal: (open, peers) => {
            const want = open && !inputYield.active

            if (want && !grabToken) {
                grabToken = acquireFocusGrab(
                    [win, ...peers],
                    () => {
                        grabToken = 0
                        // Close ONLY what this surface owns. An eviction can come from
                        // the BAR taking the slot for one of its own overlays, and
                        // reaching further than island_mode would then close whatever
                        // the other surface just opened.
                        status.island_mode = ""
                    })
                if (!grabToken) console.error("[IslandWindow] focus grab REFUSED — this surface has no modality: nothing dismisses it and its keyboard modes cannot be typed into.")
            } else if (!want && grabToken) {
                releaseFocusGrab(grabToken)
                grabToken = 0
            }

            // Layer-shell interactivity is NEVER touched here: it is set to NONE once
            // at construction and stays there. The grab carries the keyboard, and
            // asking for EXCLUSIVE on top would put this surface back in
            // m_exclusiveLSes — the list that makes Hyprland refuse to move window
            // focus at all (core/InputYield) — buying nothing.
            return grabToken !== 0
        },
        updateInputRegion,
        setShown: (shown) => {
            if (shown) { win.present(); updateInputRegion() }
            else win.set_visible(false)
        },
        raise: () => {
            try { Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY) } catch (e) {}
        },
        setTopOffset: (px) => {
            const v = Math.max(0, Math.round(px))
            if (v === topOffset) return
            topOffset = v
            try { Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, v) }
            catch (e) { console.error("[IslandWindow] top margin failed:", e) }
            // The input region is stamped in surface coordinates; the surface just
            // moved, so every rect in it has to be re-cut.
            updateInputRegion()
        },
    }
}
