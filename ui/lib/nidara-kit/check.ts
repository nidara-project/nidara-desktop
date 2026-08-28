import Gtk from "gi://Gtk?version=4.0"

/**
 * NidaraSelectionCheck — universal checkmark widget for single-select option rows.
 *
 * Drawn via Cairo matching Lucide's "check" path (M20 6 9 17l-5-5 in 24×24),
 * dynamically rendered with the widget's current CSS text color.
 * Replaces raw radio buttons across Settings and Installer for unified design language.
 */
export function NidaraSelectionCheck(size = 16, extraClasses: string[] = []): Gtk.DrawingArea {
    const da = new Gtk.DrawingArea({
        width_request: size,
        height_request: size,
        valign: Gtk.Align.CENTER,
        css_classes: ["nidara-selection-check", ...extraClasses],
    })
    da.set_can_target(false)
    da.set_draw_func((widget: Gtk.DrawingArea, cr: any, w: number, h: number) => {
        const color = widget.get_color()
        const s = Math.min(w, h) / 24
        cr.setLineWidth(2.2 * s)
        cr.setLineCap(1)   // Cairo.LineCap.ROUND
        cr.setLineJoin(1)  // Cairo.LineJoin.ROUND
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha)
        cr.moveTo(4 * s, 12 * s)
        cr.lineTo(9 * s, 17 * s)
        cr.lineTo(20 * s, 6 * s)
        cr.stroke()
    })
    return da
}
