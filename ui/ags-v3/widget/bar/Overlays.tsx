import { Gdk, Gtk } from "ags/gtk4"
import ManagedWindow from "../common/ManagedWindow"
import { LAYOUT_CONFIG, getWidgetById, SIZE_MAP, UNIT, GAP } from "../control-center/IslandGrid"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import status from "../../core/Status"
import BaseIsland from "../control-center/BaseIsland"

/**
 * 🛰️ Overlay Catcher - Full-screen click-to-dismiss surface
 * Uses DrawingArea with minimal fill so GTK4 registers hit area.
 * NOT in Hyprglass namespace list → map/unmap is safe.
 */
function OverlayCatcher(monitor: Gdk.Monitor, mid: string | number) {
    const da = new Gtk.DrawingArea({ hexpand: true, vexpand: true })
    da.set_draw_func((_w, cr, w, h) => {
        cr.setSourceRGBA(0, 0, 0, 0.002)
        cr.rectangle(0, 0, w, h)
        cr.fill()
    })

    const click = new Gtk.GestureClick()
    click.connect("pressed", () => {
        if (status.cc_open) status.cc_open = false
        if (status.nc_open) status.nc_open = false
        if (status.prism_open) status.prism_open = false
    })
    da.add_controller(click)

    return ManagedWindow({
        name: `overlay-catcher-${mid}`,
        monitor,
        statusProp: "cc_open",
        child: da,
        layout: {
            layer: Gtk4LayerShell.Layer.TOP,
            anchor: { top: true, bottom: true, left: true, right: true },
            namespace: "crystal-overlay-catcher"
        }
    })
}

interface SurfaceEntry {
    win: Gtk.Window
    topMargin: number
    hideMargin: number // Negative: above screen for top-down animation
}

/**
 * Registry of managed overlay windows per monitor 🚀
 * 
 * ANTI-FLICKER STRATEGY:
 * Glass surfaces are ALWAYS MAPPED (never map/unmap after creation).
 * Show = restore margin + opacity 1 (slides from top)
 * Hide = negative margin + opacity 0 (slides to top)
 */
export default function Overlays(monitor: Gdk.Monitor, mid: string | number = 0) {
    const ccEntries: SurfaceEntry[] = []
    
    // 0. Catcher FIRST — stacks below CC/NC/Prism in Hyprland (creation order = z-order)
    const catcher = OverlayCatcher(monitor, mid)

    // 1. Create Atomic CC Surfaces ⚛️
    LAYOUT_CONFIG.forEach(item => {
        const def = getWidgetById(item.id)
        if (!def) return

        const { w, h } = SIZE_MAP[def.size]
        const width = w * UNIT + (w - 1) * GAP
        const height = h * UNIT + (h - 1) * GAP

        const pixelX = item.x * (UNIT + GAP)
        const pixelY = item.y * (UNIT + GAP)

        const topMargin = 40 + pixelY
        const rightMargin = 12 + (356 - (pixelX + width))
        const hideMargin = -(height + 50) // Above screen

        const win = ManagedWindow({
            name: `cc-${item.id}-${mid}`,
            child: BaseIsland({
                name: def.id,
                child: def.child,
                width,
                height,
                size: def.size
            }),
            monitor,
            statusProp: "cc_open",
            layout: {
                namespace: "crystal-cc",
                layer: Gtk4LayerShell.Layer.OVERLAY,
                anchor: { top: true, right: true },
                margin: { top: hideMargin, right: rightMargin },
                width,
                height
            }
        })

        win.set_opacity(0)
        win.set_visible(true)
        ccEntries.push({ win, topMargin, hideMargin })
    })

    // NC Window
    const ncTopMargin = 40
    const ncHideMargin = -850
    const ncWindow = ManagedWindow({
        name: `nc-window-${mid}`,
        child: NotificationCenter(),
        monitor,
        statusProp: "nc_open",
        layout: {
            layer: Gtk4LayerShell.Layer.OVERLAY,
            namespace: "crystal-nc",
            anchor: { top: true, right: true },
            margin: { top: ncHideMargin, right: 12 },
            width: 420,
            height: 800
        }
    })
    ncWindow.set_opacity(0)
    ncWindow.set_visible(true)

    // Prism Window
    const prismTopMargin = 40
    const prismHideMargin = -550
    const prismWindow = ManagedWindow({
        name: `prism-window-${mid}`,
        child: Prism(),
        monitor,
        statusProp: "prism_open",
        layout: {
            layer: Gtk4LayerShell.Layer.OVERLAY,
            namespace: "crystal-prism",
            anchor: { top: true },
            margin: { top: prismHideMargin },
            width: 650,
            height: 500 
        }
    })
    prismWindow.set_opacity(0)
    prismWindow.set_visible(true)



    /**
     * 🛡️ Master Orchestrator — Slide & Opacity Toggle
     * Show: restore top margin + opacity 1 (slides down from top)
     * Hide: negative top margin + opacity 0 (slides up to top)
     */
    const sync = () => {
        const ccOpen = status.cc_open
        const ncOpen = status.nc_open
        const prismOpen = status.prism_open

        // Catcher visible when any panel is open
        catcher.set_visible(ccOpen || ncOpen || prismOpen)

        // CC surfaces
        ccEntries.forEach(entry => {
            Gtk4LayerShell.set_margin(entry.win, Gtk4LayerShell.Edge.TOP,
                ccOpen ? entry.topMargin : entry.hideMargin)
            entry.win.set_opacity(ccOpen ? 1 : 0)
        })

        // NC
        Gtk4LayerShell.set_margin(ncWindow, Gtk4LayerShell.Edge.TOP,
            ncOpen ? ncTopMargin : ncHideMargin)
        ncWindow.set_opacity(ncOpen ? 1 : 0)

        // Prism
        Gtk4LayerShell.set_margin(prismWindow, Gtk4LayerShell.Edge.TOP,
            prismOpen ? prismTopMargin : prismHideMargin)
        prismWindow.set_opacity(prismOpen ? 1 : 0)
    }

    status.connect("notify::cc-open", sync)
    status.connect("notify::nc-open", sync)
    status.connect("notify::prism-open", sync)
    sync()

    return [] // Managed externally
}
