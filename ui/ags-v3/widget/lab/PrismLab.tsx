import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import SquircleContainer from "../common/SquircleContainer"

/**
 * Satellite - A tiny window for selective refraction tests 🛰️
 */
export function Satellite(monitor: Gdk.Monitor, x: number, y: number, w: number, h: number) {
    const win = new Gtk.Window({
        name: "prism-satellite",
        css_classes: ["prism-satellite"],
        application: app,
        width_request: w,
        height_request: h
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "prism-satellite")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, y)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.LEFT, x)
        Gtk4LayerShell.set_exclusive_zone(win, -1)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    } catch (e) { }

    const content = SquircleContainer({
        child: new Gtk.Box({
            width_request: w,
            height_request: h,
            tooltip_text: "Click to close satellite 🛰️"
        }),
        radius: 12,
        alpha: 0.1,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.0 }, // NO BORDER for the satellite itself
        onClick: () => {
            console.log("[Satellite] Closing via click")
            win.close()
        }
    })

    win.set_child(content)
    win.set_visible(true)
    win.present()
    return win
}

/**
 * PrismLab - Experimental visual testing window 🧪
 */
export default function PrismLab(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "prism-lab",
        css_classes: ["prism-lab-window"],
        application: app,
        visible: false
    })

    win.set_size_request(550, 500)
    win.set_resizable(true)

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "prism-lab")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, false)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
    } catch (e) { console.error("[Lab] LayerShell Error:", e) }

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["prism-lab-box"],
        width_request: 500
    })

    const header = new Gtk.Label({
        label: "🧪 Prism Lab: Visual Evolution",
        css_classes: ["lab-header"],
        halign: Gtk.Align.START
    })
    content.append(header)

    const createSliderRow = (label: string, min: number, max: number, initial: number, step: number, onUpdate: (v: number) => void) => {
        const row = new Gtk.Box({ css_classes: ["lab-slider-row"], spacing: 16 })
        const l = new Gtk.Label({ label, css_classes: ["lab-label"], halign: Gtk.Align.START })
        const valLabel = new Gtk.Label({ label: initial.toFixed(2), css_classes: ["lab-value"] })

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, page_increment: step * 5, value: initial })
        })

        scale.connect("value-changed", () => {
            const v = scale.get_value()
            valLabel.label = v.toFixed(2)
            onUpdate(v)
        })

        row.append(l)
        row.append(scale)
        row.append(valLabel)
        return row
    }

    // Hyprglass Parameters (Experimental)
    content.append(new Gtk.Label({ label: "Hyprglass Parameters", css_classes: ["lab-section-title"], halign: Gtk.Align.START }))

    // We can't easily set hyprglass params per window yet, but we can log what we'd like to set
    content.append(createSliderRow("Refraction", 0, 5, 1, 0.05, (v) => {
        console.log(`[Lab] Target Refraction: ${v}`)
    }))

    content.append(createSliderRow("Chromatic Abb.", 0, 2, 0.6, 0.01, (v) => {
        console.log(`[Lab] Target Chromatic: ${v}`)
    }))

    // Geometry Masking (WIP)
    content.append(new Gtk.Label({ label: "Geometry Masking (WIP)", css_classes: ["lab-section-title"], halign: Gtk.Align.START }))

    const grid = new Gtk.Grid({ column_spacing: 12, row_spacing: 12, css_classes: ["lab-button-grid"] })

    const testBtn = new Gtk.Button({
        label: "Refraction Area",
        css_classes: ["lab-test-btn", "btn-refraction-test"]
    })

    const captureBtn = new Gtk.Button({
        label: "Log Geometry",
        css_classes: ["lab-test-btn", "btn-capture"]
    })

    const satelliteBtn = new Gtk.Button({
        label: "Spawn Satellite",
        css_classes: ["lab-test-btn", "btn-capture"],
        margin_start: 12
    })

    captureBtn.connect("clicked", () => {
        const alloc = testBtn.get_allocation()
        console.log(`[Lab] Button Geometry: x=${alloc.x}, y=${alloc.y}, w=${alloc.width}, h=${alloc.height}`)
        execAsync(`notify-send "Geometry Logged" "Button at ${alloc.x},${alloc.y} ${alloc.width}x${alloc.height}"`)
    })

    const satellites = new Set<any>()

    satelliteBtn.connect("clicked", () => {
        const alloc = testBtn.get_allocation()
        const win_alloc = win.get_allocation()

        // Use Gtk coordinate translation for pixel-perfect local offsets
        const [success, tx, ty] = testBtn.translate_coordinates(win, 0, 0)

        // Robust global centering using actual rendered window size
        const geom = monitor.get_geometry()

        // We assume the window is centered. 
        // If the user says it's "down and right", it means win_gx/win_gy are too large.
        // Let's try to account for the fact that win_alloc might includes margins.
        const win_gx = Math.floor((geom.width - win_alloc.width) / 2)
        const win_gy = Math.floor((geom.height - win_alloc.height) / 2)

        const gx = win_gx + (success ? tx : alloc.x)
        const gy = win_gy + (success ? ty : alloc.y)

        console.log(`[Lab] Spawning: win_g=${win_gx},${win_gy} | btn_rel=${tx},${ty} | final=${gx},${gy}`)
        const s = Satellite(monitor, gx, gy, alloc.width, alloc.height)
        satellites.add(s)
        s.connect("close-request", () => { satellites.delete(s); return false })
    })

    const clearBtn = new Gtk.Button({
        label: "Clear All",
        css_classes: ["lab-test-btn", "btn-clear"],
        margin_start: 12
    })
    clearBtn.connect("clicked", () => {
        satellites.forEach(s => s.close())
        satellites.clear()
    })

    grid.attach(testBtn, 0, 0, 1, 1)
    grid.attach(captureBtn, 1, 0, 1, 1)
    grid.attach(satelliteBtn, 2, 0, 1, 1)
    grid.attach(clearBtn, 3, 0, 1, 1)
    content.append(grid)

    // Depth Experiment Section
    content.append(new Gtk.Label({ label: "Depth & Material Testing", css_classes: ["lab-section-title"], halign: Gtk.Align.START }))
    const depthBox = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER })

    const createDepthButton = (label: string, alpha: number, gloss: boolean) => {
        const btn = new Gtk.Box({
            css_classes: ["lab-test-btn"],
            width_request: 120,
            height_request: 60
        })
        btn.append(new Gtk.Label({ label }))

        return SquircleContainer({
            child: btn,
            radius: 12,
            alpha: alpha,
            gloss: gloss,
            borderColor: { r: 1, g: 1, b: 1, a: 0.3 }
        })
    }

    depthBox.append(createDepthButton("Ghost", 0.05, false))
    depthBox.append(createDepthButton("Solid", 0.4, true))
    depthBox.append(createDepthButton("Crystal", 0.1, true))
    content.append(depthBox)

    const labWrapper = SquircleContainer({
        child: content,
        radius: 32,
        n: 4.5,
        alpha: 0.15, // Matching system glass
        color: { r: 0.05, g: 0.05, b: 0.05 }, // Darker base for lab
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.15 },
        css_classes: ["prism-lab-wrapper"]
    })

    win.set_child(labWrapper)

        ; (win as any).toggle = () => {
            const isVis = win.get_visible()
            console.log(`[PrismLab] Toggle: currently ${isVis ? 'visible' : 'hidden'}`)
            win.set_visible(!isVis)
            if (!isVis) {
                win.present()
                console.log("[PrismLab] Presenting window")
            }
        }

    return win
}
