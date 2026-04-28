import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Theme from "../../core/ThemeManager"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import Icons from "../../core/Icons"

function readFile(path: string): string {
    try {
        const [, contents] = Gio.File.new_for_path(path).load_contents(null)
        return new TextDecoder().decode(contents)
    } catch { return "" }
}

function makeCpuReader() {
    let prevIdle = 0, prevTotal = 0
    return (): number => {
        const parts = readFile("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number)
        const idle = parts[3] + (parts[4] ?? 0)
        const total = parts.reduce((a, b) => a + b, 0)
        const dIdle = idle - prevIdle, dTotal = total - prevTotal
        prevIdle = idle; prevTotal = total
        return dTotal <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
    }
}

function readRamPercent(): number {
    const text = readFile("/proc/meminfo")
    const get = (k: string) => { const m = text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")); return m ? parseInt(m[1]) : 0 }
    const total = get("MemTotal"), available = get("MemAvailable")
    return total === 0 ? 0 : Math.round((1 - available / total) * 100)
}

function makeArc(
    label: string,
    size: number,
    iconSize: number,
    poll: (cb: (v: number) => void) => void,
    interval: number,
): Gtk.Widget {
    const canvas = new Gtk.DrawingArea({
        width_request: size,
        height_request: size,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    let pct = 0
    canvas.set_draw_func((_, cr, w, h) => {
        const r = Math.min(w, h) / 2 - 2
        const xc = w / 2, yc = h / 2
        const c = Theme.isDark ? 1 : 0
        cr.setSourceRGBA(c, c, c, 0.12)
        cr.setLineWidth(size > 28 ? 3 : 2)
        cr.arc(xc, yc, r, 0, 2 * Math.PI)
        cr.stroke()
        if (pct > 0) {
            cr.setSourceRGBA(c, c, c, 0.8)
            cr.setLineWidth(size > 28 ? 3 : 2)
            cr.setLineCap(1)
            cr.arc(xc, yc, r, -Math.PI / 2, (pct / 100) * 2 * Math.PI - Math.PI / 2)
            cr.stroke()
        }
    })

    const icon = new Gtk.Label({
        label,
        css_classes: ["resource-icon"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    if (iconSize) icon.set_size_request(iconSize, iconSize)

    const overlay = new Gtk.Overlay({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
    overlay.set_child(canvas)
    overlay.add_overlay(icon)

    const sync = () => { poll(v => { if (v !== pct) { pct = v; canvas.queue_draw() } }); return true }
    sync()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, sync)

    return overlay
}

function cpuArc(size: number) {
    const read = makeCpuReader()
    read() // prime so first timer reading is a real differential
    return makeArc("C", size, size - 8, cb => cb(read()), 2000)
}

function ramArc(size: number) {
    return makeArc("M", size, size - 8, cb => cb(readRamPercent()), 5000)
}

// Bar variant: two small 24px arcs (matches original Resources.tsx dimensions)
function buildBarContent(): Gtk.Widget {
    const box = new Gtk.Box({
        name: "bar-resources-box",
        css_classes: ["bar-resources"],
        spacing: 12,
        valign: Gtk.Align.CENTER,
        margin_start: 16,
        margin_end: 16,
        margin_top: 4,
        margin_bottom: 4,
    })
    box.append(cpuArc(24))
    box.append(ramArc(24))
    return box
}

// CC variant — always WIDE (2×1). CenterBox ensures the arcs stay centered
// even after BaseIsland forces child to halign/valign FILL.
function buildContent(_size: WidgetSize): Gtk.Widget {
    const inner = new Gtk.Box({
        spacing: 24,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    inner.append(cpuArc(40))
    inner.append(ramArc(40))

    const outer = new Gtk.CenterBox()
    outer.set_center_widget(inner)
    return outer
}

const cpuMemoryWidget: AtomicWidget = {
    id: "cpu_memory",
    name: "CPU & Memoria",
    icon: Icons.cpu,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent,
    buildBarContent,
}

export default cpuMemoryWidget
