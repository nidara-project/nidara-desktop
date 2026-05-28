import { Astal, Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"

interface PillSliderProps {
    iconName: string
    value: number
    onChanged: (value: number) => void
    height?: number
    className?: string
}

/**
 * Premium Pill Slider 💊
 * Ported from Control Center for system-wide consistency.
 */
export default function PillSlider({
    iconName,
    value,
    onChanged,
    height = 48,
    className = ""
}: PillSliderProps) {

    // 1. Setup the scale (Input Layer)
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: value * 100
        }),
        css_classes: ["cc-slider-scale-input"]
    })

    // 2. Setup the DrawingArea (Visual Layer)
    const da = new Gtk.DrawingArea({
        hexpand: true,
        height_request: height,
        can_target: false
    })

    // Pre-load icon
    let iconPixbuf: any = null
    try {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
        const info = theme.lookup_icon(iconName, [], 20, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC)
        if (info) {
            const file = info.get_file()
            if (file) {
                iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(file.get_path(), 20, 20, true)
            }
        }
    } catch (e) { }

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const r = height / 2
        const insY = 2
        const insX = 2
        const x1 = insX
        const y1 = insY
        const w1 = w - insX * 2
        const h1 = h - insY * 2
        const safe_r = Math.min(r, h1 / 2)

        const drawPill = (x: number, y: number, width: number, height: number, radius: number) => {
            cr.newPath()
            cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0)
            cr.lineTo(x + width, y + height - radius)
            cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2)
            cr.lineTo(x + radius, y + height)
            cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI)
            cr.lineTo(x, y + radius)
            cr.arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2)
            cr.lineTo(x + width - radius, y)
            cr.closePath()
        }

        // 1. Background Plate
        cr.save()
        cr.setSourceRGBA(1, 1, 1, 0.1)
        drawPill(x1, y1, w1, h1, safe_r)
        cr.fill()
        cr.restore()

        // 2. Level Fill
        const fillValue = scale.adjustment.value / 100
        const fillWidth = w1 * fillValue
        if (fillWidth > 0) {
            cr.save()
            cr.setSourceRGBA(1, 1, 1, 1)
            drawPill(x1, y1, w1, h1, safe_r)
            cr.clip()
            const curRadius = Math.min(safe_r, fillWidth / 2)
            drawPill(x1, y1, fillWidth, h1, curRadius)
            cr.fill()
            cr.restore()
        }

        // 3. Icon
        if (iconPixbuf) {
            const iconX = 16
            const iconY = (h - 20) / 2
            const invertX = x1 + fillWidth

            const drawIconStencil = (color: { r: number, g: number, b: number, a: number }) => {
                cr.save()
                Gdk.cairo_set_source_pixbuf(cr, iconPixbuf, iconX, iconY)
                let maskPattern = cr.getSource()
                cr.setSourceRGBA(color.r, color.g, color.b, color.a)
                cr.mask(maskPattern)
                cr.restore()
            }

            // A. White State (Where NOT covered)
            cr.save()
            cr.rectangle(invertX, 0, w - invertX, h)
            cr.clip()
            drawIconStencil({ r: 1, g: 1, b: 1, a: 0.9 })
            cr.restore()

            // B. Dark State (Where COVERED)
            if (invertX > iconX) {
                cr.save()
                cr.rectangle(0, 0, invertX, h)
                cr.clip()
                drawIconStencil({ r: 0, g: 0, b: 0, a: 0.6 })
                cr.restore()
            }
        }
    })

    // Connections
    scale.connect("value-changed", () => {
        da.queue_draw()
        onChanged(scale.adjustment.value / 100)
    })

    // 🛡️ Sync logic: Update UI when external state changes
    // We can't use useState/createState here easily within this vanilla Gtk component
    // but we can expose a way to sync it if needed. For now, we trust the parent.

    const overlay = new Gtk.Overlay({
        css_classes: ["pill-slider-overlay", className],
        hexpand: true
    })

    overlay.set_child(scale)
    overlay.add_overlay(da)

    return overlay
}
