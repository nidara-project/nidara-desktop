import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import app from "../../../lib/host"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import { MorphRevealer } from "../../common/MorphRevealer"
import { createRegionStamper, type VisibleRect } from "../../common/VisibleRegion"
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
    // How far the whole surface is pushed down to stay level with the bar — see
    // setTopOffset. Normally 0; everything below that converts between
    // root-relative and monitor-relative coordinates has to add it. Declared up
    // here because the region stamper's clip box is measured against it.
    let topOffset = 0

    // The monitor's geometry is NOT captured — it is the stamper's, re-read on
    // `notify::geometry`. This surface was one of the two that cached it and got
    // cut off on a live resolution change (see common/VisibleRegion.ts).
    const visibleRegion = createRegionStamper({
        monitor: gdkmonitor,
        tag: "island",
        surface: () => win.get_native()?.get_surface() ?? null,
        // The surface is the monitor rect MINUS the top offset: a rect past the
        // buffer is intersected away, and an empty intersection cancels the
        // element — i.e. the island disappears.
        box: (geo) => ({ x: 0, y: 0, width: geo.width, height: geo.height - topOffset }),
        rects: () => paintedRegion(),
        onStamped: () => win.queue_draw(),
    })

    const win = new Gtk.Window({
        name: NAMESPACE,
        application: app,
        css_classes: ["nidara-island-window"],
        default_width: visibleRegion.geometry().width,
        default_height: visibleRegion.geometry().height,
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

    // Our ownership token for the compositor focus grab that IS this surface's
    // modality, 0 when we hold none — see setModal and common/FocusGrab.ts. A token rather
    // than a boolean because the BAR grabs the same single slot: it can evict us
    // between our own open and close, and a release we no longer own would take
    // down ITS grab.
    let grabToken = 0

    // Root-relative bounds of something that is actually on screen, or null.
    //
    // compute_bounds against the root, NOT get_allocation(): the capsule is
    // nested (root > row > centre box > capsule) and a child's allocation is
    // relative to its parent, so an allocation would land the rect in the wrong
    // place. Bounds are root-relative whatever the depth.
    //
    // The null is load-bearing for all three callers — it is how they tell
    // "revealed, but not laid out yet" apart from "not there", and both regions
    // below have to fall back to their safe state when they see it.
    const boundsOf = (w: Gtk.Widget | null): { x: number, y: number, w: number, h: number } | null => {
        if (!w?.get_visible() || !w.get_mapped()) return null
        const [ok, b] = w.compute_bounds(root)
        if (!ok || b.get_width() <= 1 || b.get_height() <= 1) return null
        return { x: b.get_x(), y: b.get_y(), w: b.get_width(), h: b.get_height() }
    }

    /** Everything this surface is painting right now: the capsule (plus whichever
     *  indicator chips are revealed) and any mode that is open OR still morphing.
     *  `pending` is a live revealer we could not measure — it is the one state
     *  where a region computed from these numbers would be a LIE.
     *
     *  `targetsLive`/`targetsMeasured` are the SAME distinction for the hit
     *  targets, and the input region leans on it: `hitTargets()` never returns an
     *  empty list (the capsule is always in it), so live-but-none-measurable can
     *  only mean "not laid out yet", never "nothing to click". */
    const paintedBounds = (): { rects: { x: number, y: number, w: number, h: number }[], pending: boolean,
                                targetsLive: number, targetsMeasured: number, missing: string[], byId: Record<string, string>, trace: string } => {
        const rects: { x: number, y: number, w: number, h: number }[] = []
        let pending = false
        const targets = hitTargets()
        let targetsMeasured = 0
        // A target the island MEANT to show and could not measure. This is the
        // distinction the counts cannot make (see the chips' `islandRevealed` tag):
        // a collapsed chip measuring null is the healthy resting state, while a
        // REVEALED one measuring null is a control that is about to be dropped from
        // the region and take no input until something unrelated re-stamps.
        const missing: string[] = []
        const trace: string[] = []
        // id → the rect this pass would stamp for it, "NULL" when unmeasurable. Keyed
        // so the MOVED check can compare a target against ITSELF across two samples
        // instead of comparing whole trace strings, which differ whenever the target
        // SET changes for perfectly good reasons. Built ONLY under the trap: this
        // runs once per target per stamp and stamps run per FRAME of every island
        // animation, so the formatting stays behind the flag with the trace itself.
        const byId: Record<string, string> = {}
        for (const t of targets) {
            const b = boundsOf(t)
            const id = (t as any).islandTargetId ?? "?"
            const revealed = (t as any).islandRevealed?.() !== false
            if (b) { rects.push(b); targetsMeasured++ }
            else if (revealed) missing.push(id)
            if (TRACE) {
                byId[id] = b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}` : "NULL"
                trace.push(`${id}${revealed ? "" : "-"}=${byId[id]}`)
            }
        }
        for (const r of revealers) {
            // `get_visible()` alone is not enough on the way out: a closing
            // revealer is still visible until its final tick, and tickId is the
            // only thing that says "still moving".
            if (!r.get_visible() && r.tickId === null) continue
            const b = boundsOf(r)
            if (b) rects.push(b)
            else pending = true
        }
        return { rects, pending, targetsLive: targets.length, targetsMeasured, missing, byId, trace: trace.join(" ") }
    }

    // ── Never blank our own input region ────────────────────────────────────────
    //
    // 🔑 The failure this exists for (user-caught 2026-08-13, resume from suspend):
    // ONE stamp landed with `rects=0 hitTargets=6` and the island took no pointer
    // input at all until the UI was reloaded, 33 minutes later.
    //
    // An empty region is the LEAST safe state for input, and it is terminal. The
    // capsule is permanent furniture with no re-stamp trigger of its own: the only
    // hooks that exist are the revealers' `onAllocated` (no mode was open) and the
    // morph's `onDone` (no morph ran). Nothing was ever going to correct it.
    //
    // ⚠️ Note where the BAR is different, because it is why only this surface can
    // die this way: `Bar.tsx` unions an unconditional `{0,0,width,BAR_H}` strip, a
    // constant that cannot fail to measure. The capsule is CENTRED and changes
    // width, so it has no such constant — it is measured, and measurement has an
    // unmeasurable state (widgets between an unmap and their first layout pass:
    // `present()` stamping in its own turn, a surface re-configured after a
    // suspend/lock). `boundsOf` returns null for every target and the union is
    // empty, which is indistinguishable from "click-through" once stamped.
    //
    // So: hold the region already on the surface and climb back to a real stamp.
    // Holding is only correct because we HAVE one — before the first successful
    // stamp there is no region to keep, and a Wayland surface with none takes
    // input across its whole buffer, i.e. this monitor-sized surface would swallow
    // every click on screen. That is the one case where stamping empty is right.
    let everStamped = false
    let restampSource = 0
    let restampStep = 0
    // Climbs so a genuinely stuck surface is not polled at 50ms forever; resets on
    // the first stamp that measures, so the common case is one quick retry.
    const RESTAMP_DELAYS = [50, 100, 250, 500, 1000]
    const queueRestamp = () => {
        if (restampSource) return
        const delay = RESTAMP_DELAYS[Math.min(restampStep++, RESTAMP_DELAYS.length - 1)]
        restampSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            restampSource = 0
            // Hidden for fullscreen: nothing is on screen to be clicked and
            // `setShown(true)` stamps on the way back, so let the chain die rather
            // than poll for the whole fullscreen session.
            if (win.get_visible()) updateInputRegion()
            return GLib.SOURCE_REMOVE
        })
    }
    const holdRegion = (live: number) => {
        if (TRACE) console.log(`[island-region] HELD: ${live} live target(s), none measurable — region kept, re-stamp queued`)
        queueRestamp()
    }

    // ── Verify once the layout has stopped moving ───────────────────────────────
    //
    // 🔑 A stamp can be internally IMPOSSIBLE, and measuring more carefully cannot
    // help, because the tree is mid-flight while we read it. Caught 2026-08-13
    // 16:55, minutes after the three trigger fixes landed:
    //
    //   #61  capsule=1091 297x32   agent=1396  dots=1436     healthy
    //   #62  capsule=1174 132x32   agent=1479  dots=1519     impossible
    //        MOVED, 600 ms later:  agent is at 1314, dots at 1354
    //   #63  7.6 SECONDS later, still wrong        #64  correct again
    //
    // #62's capsule is 132 wide at 1174 — which is exactly a 212-wide group centred
    // on 1280, so the chips belonged at 1314/1354. It stamped 1479/1519: a 173px
    // gap between the capsule and a chip that the layout puts 8px apart. ONE pass of
    // `paintedBounds` read the capsule with its NEW allocation and the chips with
    // their OLD one, because the `glassArea "resize"` hook fires from INSIDE
    // size-allocate, before the row's siblings have been re-allocated. Then nothing
    // re-stamped for 7.6 s, and for those 7.6 s the chips took no input.
    //
    // The three triggers cannot see this: nothing is `missing` (everything measured),
    // `child-revealed` does not fire (the chips are not revealing, they MOVED), and
    // the opacity crossing already happened. The measurement was wrong, not missing.
    //
    // So: after every stamp, re-measure once the tree is still and re-stamp if the
    // geometry moved. DEBOUNCED, not merely coalesced — during an animation stamps
    // arrive every ~7ms, and verifying per stamp would double the work on a path the
    // blur region also pays for. Pushing the timer forward on each stamp means one
    // extra measurement per animation instead of ~20, taken where it matters: after
    // the last frame, on the state that is going to persist.
    const VERIFY_MS = 50
    let verifySource = 0
    let stampedRects: { x: number, y: number, w: number, h: number }[] = []
    const sameRects = (a: typeof stampedRects, b: typeof stampedRects) =>
        a.length === b.length && a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h)
    const scheduleVerify = () => {
        if (verifySource) GLib.source_remove(verifySource)
        verifySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_MS, () => {
            verifySource = 0
            if (!win.get_visible()) return GLib.SOURCE_REMOVE
            const now = paintedBounds().rects.map(r => ({
                x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
            }))
            if (!sameRects(now, stampedRects)) {
                if (TRACE) console.error(`[island-region] TORN: the region was stamped for a layout that no longer exists — re-stamping (had ${stampedRects.length} rect(s), measured ${now.length} now)`)
                updateInputRegion()   // re-stamps and re-arms this check, which then agrees and stops
            }
            return GLib.SOURCE_REMOVE
        })
    }

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
            // Deliberately empty, so record it as such: the verify below must not
            // read a yielded surface as a torn one and stamp the island back over
            // the clicks the yield exists to let through. Ending the yield stamps.
            stampedRects = []
            if (verifySource) { GLib.source_remove(verifySource); verifySource = 0 }
            // A yield changes who gets the CLICKS, not what is painted — the island
            // is still on screen, so its blur region is computed the same way.
            updateVisibleRegion()
            win.queue_draw()
            return
        }
        // The capsule must stay clickable at all times — it is a bar control that
        // happens to be painted here. Same for whichever indicator chips are
        // currently revealed, and for an open mode.
        const painted = paintedBounds()
        // Live targets, not one of them measurable — see `holdRegion` above. The
        // blur region is still recomputed: it has its own safe state for exactly
        // this ("nothing measurable" hands the whole surface back), and it is the
        // opposite of the input region's, so it must not be skipped along with it.
        if (painted.targetsLive > 0 && painted.targetsMeasured === 0 && everStamped) {
            holdRegion(painted.targetsLive)
            updateVisibleRegion()
            return
        }
        const rounded = painted.rects.map(b => ({
            x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
        }))
        for (const b of rounded) {
            // @ts-ignore  (same untyped Cairo.Region call as Bar.tsx)
            region.unionRectangle({ x: b.x, y: b.y, width: b.w, height: b.h })
        }
        surface.set_input_region(region)
        // What is ON the surface right now, in the same rounded numbers the verify
        // will compare against — so a re-measure that agrees costs one comparison
        // and no Wayland call.
        stampedRects = rounded
        scheduleVerify()
        if (painted.targetsMeasured > 0) { everStamped = true; restampStep = 0 }
        // ── The PARTIAL case, which the guard above cannot see ──────────────────
        //
        // `holdRegion` only engages when NOTHING measured. That was the shape of the
        // resume-from-suspend bug (#136), but it is the rarer half: measured folds
        // the moment ONE target survives, and the region then goes out missing the
        // others with no retry and no trigger that would ever re-cut it. Measured on
        // this session, 2026-08-13: 116 stamps in ten minutes dropped a chip the
        // island was showing, two of them dropping the CAPSULE, every one with
        // `measured > 0` so the `=== 0` guard stayed quiet.
        //
        // A dropped target is a control the user can see and cannot click, and
        // nothing re-stamps on its own. So keep the stamp (it is the best region we
        // can describe this instant — never worse than not stamping) and climb the
        // same ladder until the missing ones measure. `missing` counts only targets
        // the island MEANT to show: a collapsed chip measuring null is the resting
        // state of three of the five, and retrying for those would poll forever.
        if (painted.missing.length > 0) {
            if (TRACE) console.log(`[island-region] PARTIAL: ${painted.missing.join(",")} revealed but unmeasurable — stamped without them, re-stamp queued`)
            queueRestamp()
        }
        updateVisibleRegion()
        win.queue_draw()   // input regions are double-buffered: apply on next commit
        if (TRACE) traceStamp(painted)
    }

    // The monitor changed shape. The blur region is the stamper's own business
    // (it re-stamps right after this), but the INPUT region is stamped here and
    // has to be re-cut too: the capsule is CENTRED, so a new width moves it, and a
    // region left at the old centre is a control painted where the compositor
    // sends nothing — the same failure as a torn stamp, from a different cause.
    // Measuring now reads the layout GTK has not redone yet, which is exactly what
    // `scheduleVerify` is for: it re-measures 50 ms later and re-stamps if the
    // geometry moved.
    visibleRegion.onGeometryChanged(() => { if (win.get_visible()) updateInputRegion() })

    // ── Region trap: `NIDARA_ISLAND_REGION_TRACE=1` ─────────────────────────────
    //
    // For the intermittent "the island's chips stop taking mouse input and only the
    // closed capsule responds". It cannot be caught by looking, and a sweep cannot
    // provoke it (see `tech-debt.md` #68 for the paths that were ruled out), so this
    // arms a trap in the user's own session instead: the next occurrence lands in the
    // log with the stamp sequence that produced it.
    //
    // ✅ IT PAID OFF, and not the way it was aimed (2026-08-13). The occurrence it
    // caught was `stamp #422 rects=0 hitTargets=6` on resume from suspend — a stamp
    // that captured EVERY target's absence, not a subset. The STALE check below
    // never fired for it: it compares `hitTargets()` counts, and that number was 6
    // on both sides. The bug was in the other column. What the trap actually
    // delivered was the LINE — one stamp, right after the resume, then nothing for
    // 33 minutes until the reload — which is what identified the mechanism now
    // guarded by `holdRegion`. Keep it armed: the chip-level stale below is still
    // unproven, and this same log is how it would be caught.
    //
    // 🔑 What it watches, and why that is the whole bug in one number. `hitTargets()`
    // returns the capsule ALONE while the indicator row is faded to nothing, so a
    // stamp taken in that window legitimately drops the chips' rects — and becomes a
    // dead patch in the bar if nothing re-stamps once they ramp back. The morph
    // ramps opacity WITHOUT a relayout, so `onAllocated` does not fire on the way
    // out; the re-stamp comes from `MorphRevealer.reveal`'s `onDone` and from nowhere
    // else. Hence: how many targets a stamp captured, against how many are live a
    // moment later with no stamp in between.
    //
    // ⚠️ Verified to FIRE by disabling that `onDone` re-stamp in `syncIslandModes`
    // for one run (*"stamped 1 target(s), 6 are live now"*). A silent trap that has
    // never been shown to trip is not evidence of anything.
    //
    // The 600 ms is not tuning: it only has to outlast the longest morph (300 ms in,
    // 220 ms out) so a stamp mid-flight is judged after the animation that would
    // legitimately correct it, not during.
    const TRACE = GLib.getenv("NIDARA_ISLAND_REGION_TRACE") === "1"
    let stampSeq = 0
    const traceStamp = (painted: ReturnType<typeof paintedBounds>) => {
        const seq = ++stampSeq
        console.log(`[island-region] stamp #${seq} rects=${painted.rects.length} hitTargets=${painted.targetsLive}`
            + ` measured=${painted.targetsMeasured}${painted.missing.length ? ` MISSING=${painted.missing.join(",")}` : ""} | ${painted.trace}`)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            if (stampSeq !== seq) return GLib.SOURCE_REMOVE   // superseded: not our verdict to give
            const live = hitTargets().length
            if (live > painted.targetsLive)
                console.error(`[island-region] STALE after #${seq}: stamped ${painted.targetsLive} target(s), ${live} are live now and nothing re-stamped — those chips are taking no input`)
            // The check the count-based one above cannot make: compare what this
            // stamp actually PUT IN THE REGION against where the same targets are
            // now. A chip that moved (the group re-centres whenever the capsule
            // changes width) or that was dropped for being unmeasurable is taking
            // no input at its painted position, and nothing re-stamps on its own.
            //
            // ⚠️ Compare only the targets in BOTH samples, by id. Comparing the whole
            // trace string cried wolf 17 times out of 17 on its first evening: opening
            // a mode fades `indicatorRow` to nothing and `hitTargets()` then correctly
            // returns the capsule ALONE, so the two strings differ for a reason that
            // is not a stale region at all. A target that left the set is not a target
            // that moved.
            const now = paintedBounds()
            const moved = Object.entries(painted.byId).filter(([id, was]) =>
                was !== "NULL" && now.byId[id] !== undefined && now.byId[id] !== "NULL" && now.byId[id] !== was)
            if (moved.length > 0 && stampSeq === seq)
                console.error(`[island-region] MOVED after #${seq}: ${moved.map(([id, was]) => `${id} stamped at ${was} but is at ${now.byId[id]}`).join("; ")} — no stamp in between, so the region is at the old coordinates and those controls take no input`)
            return GLib.SOURCE_REMOVE
        })
    }

    // ── Blur cost: what this surface actually PAINTS ────────────────────────────
    //
    // This layer is the worst offender of the three (`tech-debt.md` §46): it is the
    // monitor rect, it is blurred, and at rest it shows a ~300px capsule. Hyprland
    // charges layer blur by the surface's BOX, so every repaint of every window
    // anywhere on screen pays for all of it.
    //
    // 🔑 An open mode is declared too, and the argument that makes it safe is the
    // SAME one the bar's panels ended up using: `MorphRevealer.onAllocated` fires
    // from inside `vfunc_size_allocate`, i.e. before the snapshot of the same
    // frame, and `mount` wires it to `updateInputRegion` (which stamps this region
    // too). So the rect that describes a mode lands in the very frame that first
    // paints it — including every later relayout, which is what a growing Assistant
    // conversation or a `margin_top` re-pin is. There is no window in which the
    // region describes the capsule while the mode paints outside it.
    //
    // The one frame that genuinely cannot be measured is the turn that REVEALS a
    // mode: `set_visible(true)` runs before any layout pass, so the revealer has no
    // allocation yet. That is the `pending` case, and its answer is the whole
    // surface — the safe state — for exactly one frame, until the allocation that
    // follows re-stamps a real rect.
    //
    // 🔑 And the morph does NOT need a region that changes per frame, which was the
    // thing actually worth avoiding: a region re-declared every frame can cost more
    // than the box it saves (`tech-debt.md` §46). The morph is
    // snapshot-time only: `applyProgress` touches opacity and queues a draw, never a
    // relayout, so the revealer's allocation is FINAL from its first layout pass and
    // this rect is stamped ONCE per open and once per close. What travels is the
    // painted shape, `R = lerp(capsule, glass)` — and both ends are inside this
    // union: the capsule because it is a hit target, the glass because it is inside
    // the revealer's own box (which is also why the shape's cairo node clips itself
    // to that box + 8px). A lerp between two rects that share a top edge and a
    // centre stays inside their bounding box, so every intermediate frame is
    // covered by the rect we already declared.
    // The two paddings are wildly different on purpose, and the asymmetry is the
    // whole safety argument.
    //
    // VERTICAL is where the money is: this rect trades a 1440px-tall box for the
    // bar row at rest — nothing else paints above or below it there (the chip badge
    // overlaps its glyph, `--nidara-shadow-sm` spreads ≤3px) — and for the mode's
    // own height while one is open, which is still a fraction of the monitor. So
    // keep it tight; 16px covers the panel shadows too, the same pad the bar uses
    // for the same family of glass panels.
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
    //
    // That same pad is what makes the chips safe across a morph, and it is worth
    // saying out loud because the alternative reads as covered when it is not:
    // `hitTargets()` DROPS the chips the moment they fade to nothing (opacity 0 at
    // 35% of the morph, by design — see ActivityIsland), so a re-stamp that happens
    // mid-morph measures a union without them, and on the way back OUT they ramp
    // up again with no relayout to re-measure. They land inside the pad, not inside
    // a rect anyone computed for them.
    const BLUR_PAD_X = 200
    const BLUR_PAD_Y = 16
    // The producer the stamper calls: what this surface paints, padded, in
    // surface coordinates. Clipping to the surface box and deduping belong to the
    // stamper — this only has to answer honestly, `null` included.
    const paintedRegion = (): VisibleRect[] | null => {
        const { rects, pending } = paintedBounds()
        // A mode was revealed this turn and has no allocation yet: anything we
        // computed now would describe the capsule while the mode paints outside
        // it, and outside the region means NOT DRAWN. Give the surface back for
        // the one frame it takes `onAllocated` to hand us the real rect.
        if (pending) return null

        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const b of rects) {
            x0 = Math.min(x0, b.x);       y0 = Math.min(y0, b.y)
            x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h)
        }
        // Nothing measurable (first frames, capsule hidden): the un-optimised
        // surface is always the safe answer.
        if (!isFinite(x0)) return null

        return [{
            x: Math.round(x0) - BLUR_PAD_X,
            y: Math.round(y0) - BLUR_PAD_Y,
            width: Math.round(x1 - x0) + BLUR_PAD_X * 2,
            height: Math.round(y1 - y0) + BLUR_PAD_Y * 2,
        }]
    }
    const updateVisibleRegion = () => visibleRegion.stamp()

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
        for (const b of paintedBounds().rects) {
            x0 = Math.min(x0, b.x);       y0 = Math.min(y0, b.y)
            x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h)
        }
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
            // The capsule row is the only thing on this surface that is ALWAYS
            // painted, and until now it was the only one with no re-stamp trigger
            // — the revealers get `onAllocated` above, the morph gets `onDone`,
            // and the permanent furniture got nothing. So a region stamped while
            // the row was unmapped stayed wrong for as long as the session lasted
            // (see `holdRegion`). `map` is the exact moment the widgets we measure
            // come back: after a `setShown(true)`/`present()`, or a surface the
            // compositor re-configured coming out of suspend. If the allocation is
            // not final yet the stamp holds and the retry ladder finishes the job.
            row.connect("map", () => updateInputRegion())
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
