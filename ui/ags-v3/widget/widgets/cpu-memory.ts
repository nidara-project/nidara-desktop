import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Theme from "../../core/ThemeManager"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
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
        if (w <= 0 || h <= 0) return
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

// CC metric: a ring with the live percentage in its centre and a caption below
// (CPU / RAM). Clearer than the bar's bare-letter arcs — you read the value, not a
// cryptic glyph. Ring colour stays neutral (accent is reserved for selection).
function makeCCMetric(
    caption: string,
    ring: number,
    gap: number,
    poll: (cb: (v: number) => void) => void,
    interval: number,
): Gtk.Widget {
    const lineW = ring > 48 ? 5 : 4
    const canvas = new Gtk.DrawingArea({
        width_request: ring, height_request: ring,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    })
    let pct = 0
    canvas.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const r = Math.min(w, h) / 2 - lineW / 2 - 1
        const xc = w / 2, yc = h / 2
        const c = Theme.isDark ? 1 : 0
        cr.setLineCap(1)
        cr.setSourceRGBA(c, c, c, 0.14)
        cr.setLineWidth(lineW)
        cr.arc(xc, yc, r, 0, 2 * Math.PI)
        cr.stroke()
        if (pct > 0) {
            cr.setSourceRGBA(c, c, c, 0.88)
            cr.setLineWidth(lineW)
            cr.arc(xc, yc, r, -Math.PI / 2, (pct / 100) * 2 * Math.PI - Math.PI / 2)
            cr.stroke()
        }
    })

    const value = new Gtk.Label({
        label: "0", css_classes: ["resource-value"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    })
    const overlay = new Gtk.Overlay({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    overlay.set_child(canvas)
    overlay.add_overlay(value)

    const cap = new Gtk.Label({ label: caption, css_classes: ["resource-caption"], halign: Gtk.Align.CENTER })

    const col = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: gap,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    })
    col.append(overlay)
    col.append(cap)

    const sync = () => { poll(v => { if (v !== pct) { pct = v; value.label = `${v}`; canvas.queue_draw() } }); return true }
    sync()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, sync)
    return col
}

function cpuMetric(ring: number, gap: number) {
    const read = makeCpuReader()
    read() // prime so first timer reading is a real differential
    return makeCCMetric(t("widget.cpu-memory.cpu"), ring, gap, cb => cb(read()), 2000)
}

function ramMetric(ring: number, gap: number) {
    return makeCCMetric(t("widget.cpu-memory.ram"), ring, gap, cb => cb(readRamPercent()), 5000)
}

// CC variant. CenterBox keeps the metrics centered even after BaseIsland forces the
// child to halign/valign FILL. Small (1×1) shows just CPU — two rings don't fit a
// single cell; Medium/Large show CPU + RAM. SINGLE/WIDE have only ~56px of vertical
// room (80px cell − the island's 12px top+bottom padding), so the ring stays small
// enough that ring+caption fits without growing the tile; SQUARE has 148px to spare.
function buildContent(size: WidgetSize): Gtk.Widget {
    const large = size === WidgetSize.SQUARE
    const ring = large ? 56 : 34
    const gap  = large ? 5 : 2
    const inner = new Gtk.Box({
        spacing: large ? 28 : 20,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    inner.append(cpuMetric(ring, gap))
    if (size !== WidgetSize.SINGLE) inner.append(ramMetric(ring, gap))

    const outer = new Gtk.CenterBox()
    outer.set_center_widget(inner)
    return outer
}

const cpuMemoryWidget: AtomicWidget = {
    id: "cpu_memory",
    name: t("widget.cpu-memory.name"),
    icon: Icons.cpu,
    locations: ["bar", "cc"],
    defaultInBar: true,
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    centerContent: true,
    buildContent,
    buildBarContent,
}

export default cpuMemoryWidget
