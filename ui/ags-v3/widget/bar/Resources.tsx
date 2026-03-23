import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

/**
 * Resource Circle - High Fidelity Canvas Monitor 🍎
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

        // Background track
        cr.setSourceRGBA(1, 1, 1, 0.1) // Subtle white track
        cr.setLineWidth(2)
        cr.arc(xc, yc, radius, 0, 2 * Math.PI)
        cr.stroke()

        // Progress arc
        if (percentage > 0) {
            cr.setSourceRGBA(1, 1, 1, 0.8) // Solid white progress
            cr.setLineWidth(2)
            cr.setLineCap(1) // Round caps
            const angle = (percentage / 100) * 2 * Math.PI
            cr.arc(xc, yc, radius, -Math.PI / 2, angle - Math.PI / 2)
            cr.stroke()
        }
    })

    const iconProps: any = {
        pixel_size: 12,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        css_classes: ["resource-icon"]
    }

    if (iconName.startsWith("/") || iconName.startsWith("file://")) {
        iconProps.file = iconName.replace("file://", "")
    } else {
        iconProps.icon_name = iconName
    }

    const icon = new Gtk.Image(iconProps)

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
 * CPU and RAM Monitor Module 📊
 */
export default function SystemResources() {
    const box = new Gtk.Box({
        name: "bar-resources-box",
        css_classes: ["bar-resources"],
        spacing: 12,
        valign: Gtk.Align.CENTER,
        margin_start: 16, // Unified 16px 📐
        margin_end: 16,
        margin_top: 4,
        margin_bottom: 4
    })

    const cpu = ResourceCircle(`${GLib.get_home_dir()}/.config/crystal-shell/ui/ags-v3/assets/logos/cpu.svg`, (cb) => {
        execAsync(["bash", "-c", "LC_ALL=C top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'"]).then(out => {
            const val = parseFloat(out.trim().replace(",", "."))
            cb(isNaN(val) ? 0 : Math.floor(val))
        }).catch(() => cb(0))
    }, 2000)

    const ram = ResourceCircle(`${GLib.get_home_dir()}/.config/crystal-shell/ui/ags-v3/assets/logos/ram.svg`, (cb) => {
        execAsync(["bash", "-c", "LC_ALL=C free -m | grep Mem | awk '{print $3/$2 * 100}'"]).then(out => {
            const val = parseFloat(out.trim().replace(",", "."))
            cb(isNaN(val) ? 0 : Math.floor(val))
        }).catch(() => cb(0))
    }, 5000)

    box.append(cpu)
    box.append(ram)

    return box
}
