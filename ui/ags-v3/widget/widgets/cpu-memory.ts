import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import Theme from "../../core/ThemeManager"
import { AtomicWidget, WidgetSize } from "../control-center/Types"

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

    const sync = () => { poll(v => { pct = v; canvas.queue_draw() }); return true }
    sync()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, sync)

    return overlay
}

function cpuArc(size: number) {
    return makeArc("C", size, size - 8, cb =>
        execAsync(["bash", "-c", "LC_ALL=C top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'"])
            .then(o => { const v = parseFloat(o.trim().replace(",", ".")); cb(isNaN(v) ? 0 : Math.floor(v)) })
            .catch(() => cb(0)),
        2000,
    )
}

function ramArc(size: number) {
    return makeArc("M", size, size - 8, cb =>
        execAsync(["bash", "-c", "LC_ALL=C free -m | grep Mem | awk '{print $3/$2 * 100}'"])
            .then(o => { const v = parseFloat(o.trim().replace(",", ".")); cb(isNaN(v) ? 0 : Math.floor(v)) })
            .catch(() => cb(0)),
        5000,
    )
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
    icon: "computer-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent,
    buildBarContent,
}

export default cpuMemoryWidget
