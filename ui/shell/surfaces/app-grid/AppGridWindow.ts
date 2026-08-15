import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import AppGridPanel from "./AppGrid"
import { createRegionStamper, type VisibleRect } from "../../common/VisibleRegion"
import { acquireFocusGrab, releaseFocusGrab } from "../../common/FocusGrab"
import status from "../../core/Status"
import inputYield from "../../core/InputYield"
import hs from "../../core/HyprlandState"

// The app grid's OWN layer surface — the SECOND exception to "overlays live
// inside the Bar's window" (skill commandment #5), after the Activity Island.
//
// WHY IT MOVED (2026-08-09). It used to be a `Gtk.Overlay` child of the DOCK's
// window, and the coupling was deliberate: opening the grid also REVEALED the
// dock, so Super reached the dock when a fullscreen window or auto-hide had put
// it away. The owner traded that away for the cost, and the cost is blur.
//
// Hyprland charges layer blur by the surface's BOX. The dock's surface is the
// whole monitor and only PAINTS a pill, which is why it declares a tight visible
// region (`tech-debt.md` §46) — but a grid living inside it can paint anywhere,
// so every open had to hand the whole 2560x1440 box back and blur it. The saving
// evaporated exactly when the screen was busiest: a panel opening, animating,
// over whatever was already on screen.
//
// Split apart, each surface declares what it actually paints. The dock keeps its
// pill rect in EVERY state (its axis no longer has an app-grid branch at all),
// and this surface declares the panel's rect — and only exists while the grid is
// open, so at rest it costs nothing: an unmapped surface has no blur pass.
//
// WHY THE EXCEPTION IS EARNED, not borrowed from the island. The island's reason
// is that a surface cannot blur its own siblings. This one's is narrower and
// purely economic: the grid is a monitor-sized, blurred, MOSTLY-CLOSED overlay,
// and that combination is the one case where sharing a window costs the host
// surface its region for the whole time the guest is up. CC / NC / Prism are not
// in that position — they are small, they sit on the bar's surface, and the bar
// pays for them only while they are open (`tech-debt.md` §46's remaining item).
//
// WHAT WAS LOST, on purpose: Super no longer reveals the dock. The dock is
// reachable the way it always was otherwise — the pointer at the screen edge —
// and it stays CLICKABLE with the grid open, because its windows go into this
// surface's focus grab as peers (see `openGrab`).

const NAMESPACE = "nidara-app-grid"

// Enough to cover the squircle's soft Cairo edge and its drop shadow, which sit
// outside the widget's allocation. Unlike the island's rect this one carries no
// MOTION budget: the panel is centred, so it does not slide sideways under a late
// stamp — and the pop animation only ever paints INSIDE the final allocation
// (OVERLAY_POP scales 0.97 → 1.0 at snapshot time, `animateLayout: false`, so the
// allocation is the final one from the first frame).
// ⚠️ It does RESIZE, though — see the stamping note below. "Centred" is not
// "fixed", and reading the first as the second is what left a stale input rect.
const BLUR_PAD = 48

export interface AppGridWindowHandle {
    win: Gtk.Window
}

/**
 * @param peers windows that must stay clickable THROUGH our focus grab — the
 *   dock's, so its icons still launch with the grid open (that is what the old
 *   in-dock `inDockStrip` carve-out bought). A GETTER because the dock window is
 *   rebuilt on a position/auto-hide change, which would leave a captured
 *   reference pointing at a closed surface.
 */
export function AppGridWindow(
    gdkmonitor: Gdk.Monitor,
    peers: () => (Gtk.Window | null)[],
): Gtk.Window {
    // The monitor's geometry belongs to the stamper, which re-reads it on a
    // scale/resolution change. This surface was already correct before the stamper
    // existed (it refreshed by hand) and is converted anyway: the two surfaces that
    // got this wrong got it wrong because subscribing was OPTIONAL, so leaving a
    // hand-rolled copy here would keep the option open. It used to be covered for
    // free in a third way — the grid lived in the dock's window, and `app.ts`
    // rebuilds THAT on `notify::geometry` — a coupling the move to its own surface
    // quietly dropped.
    const visibleRegion = createRegionStamper({
        monitor: gdkmonitor,
        tag: "app-grid",
        surface: () => win.get_native()?.get_surface() ?? null,
        rects: () => paintedRegion(),
    })
    const win = new Gtk.Window({
        name: NAMESPACE,
        application: app,
        css_classes: ["nidara-app-grid-window"],
        default_width: visibleRegion.geometry().width,
        default_height: visibleRegion.geometry().height,
        visible: false,
    })

    const root = new Gtk.Overlay({ valign: Gtk.Align.FILL, vexpand: true })
    // Same contract as the island's root: an empty main child so the overlay
    // children keep their alignment, catching nothing — the input region below
    // only ever covers the panel.
    root.set_child(new Gtk.Box())
    win.set_child(root)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, NAMESPACE)
        // OVERLAY, above the dock's TOP and level with the island. The grid is a
        // full-screen modal surface: nothing of ours should paint over it.
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        for (const edge of [Gtk4LayerShell.Edge.TOP, Gtk4LayerShell.Edge.LEFT,
                            Gtk4LayerShell.Edge.RIGHT, Gtk4LayerShell.Edge.BOTTOM])
            Gtk4LayerShell.set_anchor(win, edge, true)
        // -1 = ignore every exclusive zone, ours and everyone else's, so the
        // surface is EXACTLY the monitor rect and the panel centres on the SCREEN
        // rather than on what is left after the bar and the dock reserve theirs.
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        // NONE, like every other surface of ours: the compositor focus grab carries
        // the keyboard (see common/FocusGrab.ts). Asking layer-shell for EXCLUSIVE
        // would put us in Hyprland's `m_exclusiveLSes`, which makes it refuse to
        // move window focus at all — the thing core/InputYield exists to work around.
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
        Gtk4LayerShell.set_monitor(win, gdkmonitor)
    } catch (e) {
        console.error("[AppGridWindow] LayerShell failed:", e)
    }

    // GTK still has to route keys to the search entry once the grab has handed us
    // the keyboard. Safe to set once: the window is unmapped whenever the grid is
    // closed, and an unmapped window takes no focus.
    win.set_focusable(true)
    win.set_focus_visible(true)

    // Through HyprlandState, never `hs.focusWorkspace` directly — the switch has to
    // happen with the grab already handed over, and `focusWorkspaceFromShell` owns
    // that order.
    const panel = AppGridPanel(gdkmonitor, () => { status.app_grid_open = false },
                               (id) => hs.focusWorkspaceFromShell(id))
    panel.widget.visible = false
    panel.widget.halign = Gtk.Align.CENTER
    panel.widget.valign = Gtk.Align.CENTER
    root.add_overlay(panel.widget)

    // ── Regions ───────────────────────────────────────────────────────────────
    //
    // Both are computed from the SAME bounds, for the same reason the dock computes
    // its two together: they answer "where is the panel", and computing them apart
    // lets them drift. They are not the same rectangle — the blur rect is padded,
    // the input rect is not, because padding what you can CLICK would put a 48px
    // dead ring around the panel that swallows the outside press that dismisses it.
    //
    // The blur rect goes out through the stamper, but it is still measured HERE,
    // in the same pass as the input rect — the producer below just hands over what
    // this one found. Re-measuring inside the producer would be the drift this
    // section exists to prevent, and the island proved it is not theoretical: one
    // pass reading two widgets at different moments of a size-allocate stamped a
    // geometrically impossible region (see IslandWindow's `scheduleVerify`).
    let painted: VisibleRect | null = null
    const paintedRegion = () => painted ? [painted] : null
    let lastInputKey = ""
    const stampRegions = (): boolean => {
        const surface = win.get_native()?.get_surface()
        if (!surface?.set_input_region) return false

        const region = new Cairo.Region()

        // Yielded for an agent action (core/InputYield): fully click-through, so a
        // synthetic click reaches the app it was aimed at rather than this surface.
        // The grid is still PAINTED, so its blur rect is computed the same way — a
        // yield changes who gets the clicks, not what is on screen.
        const yielded = inputYield.active

        const [ok, b] = panel.widget.compute_bounds(root)
        const measurable = ok && b.get_width() > 1 && b.get_height() > 1
                           && panel.widget.get_visible() && panel.widget.get_mapped()
        if (!measurable) {
            // Nothing to describe yet: presented this frame, not laid out. The
            // un-optimised surface is the safe answer for BLUR (a wrong rect there
            // erases the grid), and an EMPTY one is the safe answer for INPUT (a
            // wrong rect there makes a monitor-sized surface eat every click on
            // screen). Opposite defaults, same principle: fail towards invisible.
            if (lastInputKey !== "empty") { lastInputKey = "empty"; surface.set_input_region(region) }
            painted = null
            visibleRegion.stamp()
            win.queue_draw()
            return false
        }

        const bx = Math.round(b.get_x()), by = Math.round(b.get_y())
        const bw = Math.round(b.get_width()), bh = Math.round(b.get_height())
        const inputKey = yielded ? "yield" : `${bx},${by},${bw},${bh}`
        if (!yielded) {
            // @ts-ignore  (same untyped Cairo.Region call as Bar.tsx / IslandWindow.ts)
            region.unionRectangle({ x: bx, y: by, width: bw, height: bh })
        }
        // Dedupe both regions by key, so calling this more often than necessary is
        // free. That is what lets the resize hook below be generous: a stamp that
        // changes nothing must not reach `queue_draw`, or a caller on the frame
        // clock would repaint the surface every frame — the expensive failure mode
        // this whole mechanism exists to avoid.
        const unchanged = inputKey === lastInputKey
        if (!unchanged) { lastInputKey = inputKey; surface.set_input_region(region) }

        // Padded, unclipped: the stamper cuts it to the monitor and dedupes it.
        painted = { x: bx - BLUR_PAD, y: by - BLUR_PAD, width: bw + BLUR_PAD * 2, height: bh + BLUR_PAD * 2 }
        visibleRegion.stamp()
        // Input regions are double-buffered — they apply on the surface's next
        // commit — so a stamp that changed something has to ride a repaint.
        if (!unchanged) win.queue_draw()
        return true
    }

    // A window presented this frame has no allocation, so the first stamp cannot
    // describe anything (see `measurable` above). Ride the frame clock until it can,
    // then stop — this is NOT a per-frame region, which would be the expensive kind
    // (a rect that changes every frame costs more than the box it saves).
    //
    // ⚠️ Stopping is only safe because something else re-starts it. The first version
    // stopped for good, on the reasoning that "the panel is centred at a fixed size,
    // so the rect never slides" — which is FALSE: `filterApps` swaps the fixed-height
    // scroller for the short no-results box, so a search that matches nothing shrinks
    // the panel from ~738px to ~280px. The frozen INPUT rect then kept swallowing
    // clicks over ~630px of visibly empty screen, where every other pixel dismisses
    // (found 2026-08-09 by asking why the surface is still monitor-sized). The blur
    // rect merely stayed too big, which is the harmless direction — the input rect is
    // the one that misbehaves when stale.
    let stampTick = 0
    let settled = 0
    const stopStamping = () => {
        if (!stampTick) return
        win.remove_tick_callback(stampTick)
        stampTick = 0
    }
    const startStamping = () => {
        settled = 0
        if (stampTick) return
        stampTick = win.add_tick_callback(() => {
            if (stampRegions() && ++settled >= 2) { stampTick = 0; return GLib.SOURCE_REMOVE }
            return GLib.SOURCE_CONTINUE
        })
    }

    // Any change to the panel's size re-opens the stamping window. Hooked on the
    // squircle's own DrawingArea rather than on the no-results toggle that prompted
    // it: `resize` fires for EVERY cause, including ones added later, and the
    // key-dedupe above makes a stamp that changes nothing free. Same hook `Bar.tsx`
    // uses to follow the island capsule.
    panel.glassArea?.connect("resize", () => { if (status.app_grid_open) startStamping() })

    // Same idea one level out: the monitor changed shape, so the panel is centred
    // somewhere else. The stamper has already re-cut the blur rect against the new
    // box by the time this runs; re-opening the stamping window is for the INPUT
    // rect, which is measured here and would otherwise keep swallowing clicks over
    // the panel's old position.
    visibleRegion.onGeometryChanged(() => { if (status.app_grid_open) startStamping() })

    // ── Modality ──────────────────────────────────────────────────────────────
    //
    // Our ownership token for the compositor focus grab that IS the grid's
    // modality; 0 when we hold none, which is a broken grid rather than a slower
    // one — there is no layer-shell fallback left. A token rather than a boolean
    // because the bar and the island grab the same single compositor slot and can
    // evict us, and releasing a token we no longer own would take down THEIR grab.
    let grabToken = 0

    // The compositor took the grab away. A popup is NOT one of the causes that reach
    // here — FocusGrab suspends the lease for the life of a `Gtk.Popover` in our tree
    // (which is what let the grid keep its context menus) — so what is left is an
    // outside press or an eviction, and the grid's answer to both is to close.
    const onGrabCleared = () => {
        grabToken = 0
        status.app_grid_open = false
    }

    const openGrab = () => {
        if (grabToken || inputYield.active) return
        grabToken = acquireFocusGrab([win, ...peers()], onGrabCleared)
        if (!grabToken)
            console.error("[AppGrid] focus grab REFUSED — the grid has no modality: it cannot be typed into and nothing dismisses it.")
    }
    const closeGrab = () => {
        if (!grabToken) return
        releaseFocusGrab(grabToken)
        grabToken = 0
    }

    // Step aside while an agent acts on another app (core/InputYield): the grab
    // clamps pointer focus to this surface, so a synthetic click could not reach the
    // app it was aimed at.
    inputYield.registerHolder(() => status.app_grid_open)
    inputYield.connect("notify::active", () => {
        if (!status.app_grid_open) return
        if (inputYield.active) closeGrab()
        else openGrab()
        stampRegions()
    })

    // ── Open / close ──────────────────────────────────────────────────────────
    const open = () => {
        win.present()
        panel.onShow()
        panel.setVisible(true)
        openGrab()
        startStamping()
    }

    const close = () => {
        stopStamping()
        closeGrab()
        panel.setActive(false)
        win.set_focus(null)
        // Drop the input region NOW, not when the animation ends: for the 150ms the
        // panel takes to shrink away this surface should already be click-through,
        // so the click that closed it is the last one it ever eats. The blur rect
        // stays — the panel is still painting, and it only shrinks INSIDE the rect
        // we already declared.
        const surface = win.get_native()?.get_surface()
        if (surface?.set_input_region) surface.set_input_region(new Cairo.Region())
        panel.setVisible(false, () => {
            // Unmapping is what makes the closed grid free: Hyprland runs no blur
            // pass for a surface that is not there. Guarded because a re-open inside
            // the 150ms would otherwise be hidden by its own predecessor's callback.
            // Nothing to reset afterwards: the re-open realizes a NEW Gdk.Surface and
            // the stamper keys its dedupe on the surface it stamped (this used to be
            // a hand-cleared `lastBlurKey`, and it was the only surface that
            // remembered to do it).
            if (!status.app_grid_open) win.set_visible(false)
        })
    }

    status.connect("notify::app-grid-open", () => {
        if (status.app_grid_open) open()
        else close()
    })

    const keyCtrl = new Gtk.EventControllerKey()
    keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    keyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
        if (!status.app_grid_open) return false
        return panel.handleKey(keyval)
    })
    win.add_controller(keyCtrl)

    return win
}

export default AppGridWindow
