import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import { MorphRevealer } from "../../common/MorphRevealer"
import { dockSideState } from "../dock/state"

// The Activity Island's OWN layer surface — the one documented exception to
// "overlays live inside the Bar's window" (skill commandment #5).
//
// WHY. Hyprland's layer blur difumina what is BEHIND a surface, once, at
// composite time. Everything painted inside one GTK window lands in one
// buffer, so the island's glass could never blur the bar capsules it grows
// over: Cairo has no backdrop-filter, and at the default 0.05 glass alpha the
// capsules read through it sharp and untouched (the bug this file fixes).
// A SEPARATE surface on a HIGHER layer level is rendered after the bar, so the
// blur pass samples the bar — capsules included — and the island finally reads
// as glass over the bar instead of a pane of cling film.
//
// VERIFIED, not assumed (2026-07-25, Hyprland 0.55.4): a throwaway layer
// surface on OVERLAY with `ignore_alpha = 0.01` blurred the bar beneath it at
// glass alphas 0.05 / 0.20 / 0.38 alike. `new_optimizations` does not restrict
// blur sampling to the background, and `xray` is off.
//
// WHY NOT A POPOVER (the other candidate, as Settings' dropdowns do it):
// popups are blurred under `popups_ignorealpha = 0.30`, a DIFFERENT knob from
// a layer's `ignore_alpha`, and it cannot be lowered without Hyprland blurring
// the popup's own drop shadow into a halo. A popover island would have to floor
// its glass at 0.38 (as `NidaraTheme.popoverAlpha` does) and would stop
// honouring the user's opacity setting. A layer keeps 0.05.
//
// GEOMETRY. Anchored on all four edges with `exclusive_zone = -1`, so the
// surface is EXACTLY the monitor rect no matter what the bar and the dock
// reserve — a deterministic origin the morph can be rebased onto. The bar's
// own surface is NOT the monitor rect (a non-auto-hiding side dock's exclusive
// zone insets it), hence `sourceOffset` below.

const NAMESPACE = "nidara-island"

export interface IslandWindowHandle {
    win: Gtk.Window
    /** Mount point for the mode revealers (same alignment contract as the bar's
     *  master overlay: they set their own valign/halign + margin_top). */
    mount: (revealers: MorphRevealer[]) => void
    /** Origin of the BAR's surface relative to ours, for the morph's source
     *  rects. Pass the bar window; measured, not derived from dock constants. */
    sourceOffset: (barWin: Gtk.Window) => { dx: number, dy: number }
    /** Map the surface and call back on the next frame, once it can be measured
     *  — the morph reads the capsule's bounds through this window's root, and an
     *  unmapped root would silently degrade it to the centered fallback pop. */
    open: (onReady: () => void) => void
    /** Unmap once the closing morph has collapsed (no idle blur pass). */
    close: () => void
    setKeyboardGrab: (grab: boolean) => void
    updateInputRegion: () => void
    /** Re-assert our layer level. Hyprland appends a surface to its layer list
     *  when the level is (re)set, so whenever the BAR moves to OVERLAY too (bar
     *  overlay mode) it would land after us and cover the island. */
    raise: () => void
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
    // nothing — the input region below only ever covers the island itself.
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
        // -1 = ignore every exclusive zone, ours and everyone else's. Without it
        // the bar's own 40px reservation would push this surface down by 40 and
        // the morph's rects would be off by exactly that.
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
        Gtk4LayerShell.set_monitor(win, gdkmonitor)
    } catch (e) {
        console.error("[IslandWindow] LayerShell failed:", e)
    }

    let mounted: MorphRevealer[] = []

    const updateInputRegion = () => {
        const surface = win.get_native()?.get_surface()
        if (!surface?.set_input_region) return
        const region = new Cairo.Region()
        // ONLY the island itself. Everything else stays click-through so the
        // bar's catcher underneath keeps receiving the outside-clicks that
        // dismiss overlays — the dismissal path is unchanged by the move.
        for (const r of mounted) {
            if (!r.get_visible()) continue
            const alloc = r.get_allocation()
            if (alloc.width <= 1 || alloc.height <= 1) continue
            // @ts-ignore  (same untyped Cairo.Region call as Bar.tsx)
            region.unionRectangle({
                x: Math.round(alloc.x), y: Math.round(alloc.y),
                width: Math.round(alloc.width), height: Math.round(alloc.height),
            })
        }
        surface.set_input_region(region)
        win.queue_draw()   // input regions are double-buffered: apply on next commit
    }

    return {
        win,
        mount: (revealers) => {
            mounted = revealers
            for (const r of revealers) root.add_overlay(r)
        },
        sourceOffset: (barWin) => {
            // We are the monitor rect; the bar may be inset by a side dock's
            // exclusive zone. Measure the inset from the bar's actual width
            // rather than recomputing the dock's geometry — the compositor is
            // the authority on how much it actually reserved. Only a LEFT dock
            // moves the bar's ORIGIN; a right one only shortens it.
            const barW = barWin.get_width()
            const inset = barW > 0 ? Math.max(0, monGeo.width - barW) : 0
            return { dx: dockSideState.position === "left" ? inset : 0, dy: 0 }
        },
        open: (onReady) => {
            if (!win.get_visible()) win.present()
            // Defer one frame so the surface is mapped and laid out before the
            // morph reads bounds through it (same idiom as the bar's expansion
            // panel). Skipping this costs the capsule morph its source rect and
            // silently drops to the fallback pop.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => { onReady(); return GLib.SOURCE_REMOVE })
        },
        close: () => { win.set_visible(false) },
        setKeyboardGrab: (grab) => {
            try {
                Gtk4LayerShell.set_keyboard_mode(win, grab
                    ? Gtk4LayerShell.KeyboardMode.EXCLUSIVE
                    : Gtk4LayerShell.KeyboardMode.NONE)
            } catch (e) { console.error("[IslandWindow] keyboard mode failed:", e) }
        },
        updateInputRegion,
        raise: () => {
            try { Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY) } catch (e) {}
        },
    }
}
