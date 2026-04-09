import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Theme from "../../core/ThemeManager"

function readFile(path: string): string {
    try {
        const [, contents] = Gio.File.new_for_path(path).load_contents(null)
        return new TextDecoder().decode(contents)
    } catch {
        return ""
    }
}

// CPU: differential measurement between two /proc/stat reads
let prevIdle = 0
let prevTotal = 0

function readCpuPercent(): number {
    const line = readFile("/proc/stat").split("\n")[0] // "cpu  u n s i ..."
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    const idle = parts[3] + (parts[4] ?? 0) // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0)
    const diffIdle = idle - prevIdle
    const diffTotal = total - prevTotal
    prevIdle = idle
    prevTotal = total
    if (diffTotal === 0) return 0
    return Math.round((1 - diffIdle / diffTotal) * 100)
}

function readRamPercent(): number {
    const text = readFile("/proc/meminfo")
    const get = (key: string) => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))
        return m ? parseInt(m[1]) : 0
    }
    const total = get("MemTotal")
    const available = get("MemAvailable")
    if (total === 0) return 0
    return Math.round((1 - available / total) * 100)
}

/**
 * Resource Circle - High Fidelity Canvas Monitor
 */
function ResourceCircle(iconName: string, update: (cb: (val: number) => void) => void, interval = 2000) {
    const canvas = new Gtk.DrawingArea({
        css_classes: ["resource-canvas"],
        width_request: 24,
        height_request: 24,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })

    let percentage = 0

    canvas.set_draw_func((area, cr, width, height) => {
        const radius = Math.min(width, height) / 2 - 2
        const xc = width / 2
        const yc = height / 2

        const c = Theme.isDark ? 1 : 0
        cr.setSourceRGBA(c, c, c, 0.1)
        cr.setLineWidth(2)
        cr.arc(xc, yc, radius, 0, 2 * Math.PI)
        cr.stroke()

        if (percentage > 0) {
            cr.setSourceRGBA(c, c, c, 0.8)
            cr.setLineWidth(2)
            cr.setLineCap(1)
            const angle = (percentage / 100) * 2 * Math.PI
            cr.arc(xc, yc, radius, -Math.PI / 2, angle - Math.PI / 2)
            cr.stroke()
        }
    })

    const icon = new Gtk.Label({
        label: iconName,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        css_classes: ["resource-icon"]
    })

    const overlay = new Gtk.Overlay({
        css_classes: ["resource-circle"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })
    overlay.set_child(canvas)
    overlay.add_overlay(icon)

    const sync = () => {
        update((val) => {
            percentage = val
            canvas.queue_draw()
        })
        return true
    }

    sync()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, sync)

    return overlay
}

/**
 * CPU and RAM Monitor Module
 */
export default function SystemResources() {
    const box = new Gtk.Box({
        name: "bar-resources-box",
        css_classes: ["bar-resources"],
        spacing: 12,
        valign: Gtk.Align.CENTER,
        margin_start: 16,
        margin_end: 16,
        margin_top: 4,
        margin_bottom: 4
    })

    // Prime the CPU differential so first reading isn't 100%
    readCpuPercent()

    const cpu = ResourceCircle("C", (cb) => cb(readCpuPercent()), 2000)
    const ram = ResourceCircle("M", (cb) => cb(readRamPercent()), 5000)

    box.append(cpu)
    box.append(ram)

    return box
}
