import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import Cairo from "gi://cairo"
import { CrystalButton } from "../../lib/crystal-ui"
import { makeHSlider } from "./Slider"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

// Minimal circular avatar cropper: pan (drag) + zoom (slider) over a fixed square
// canvas with a circular cutout, then renders the framed region to a square pixbuf
// at SAVE resolution (cropped from the source at full quality, not from the canvas).
const DISPLAY = 320   // editing canvas, square (px)
const SAVE = 256      // output avatar resolution (px) — stored bigger than shown
const MAX_ZOOM = 4

export function showAvatarCropper(
    parentWin: Gtk.Window | null,
    srcPath: string,
    onAccept: (pixbuf: any) => void,
) {
    let pixbuf: any
    try { pixbuf = GdkPixbuf.Pixbuf.new_from_file(srcPath) } catch { return }
    const iw = pixbuf.get_width(), ih = pixbuf.get_height()

    // minScale = the image always COVERS the square (no empty area in the circle).
    const minScale = Math.max(DISPLAY / iw, DISPLAY / ih)
    let scale = minScale
    let offX = (DISPLAY - iw * scale) / 2
    let offY = (DISPLAY - ih * scale) / 2

    // Keep the image covering the canvas: offset can't pull an edge inside it.
    const clampOff = () => {
        const sw = iw * scale, sh = ih * scale
        offX = Math.min(0, Math.max(DISPLAY - sw, offX))
        offY = Math.min(0, Math.max(DISPLAY - sh, offY))
    }

    const area = new Gtk.DrawingArea({
        width_request: DISPLAY, height_request: DISPLAY,
        css_classes: ["avatar-cropper-canvas"],
    })
    area.set_draw_func((_: any, cr: any, w: number, h: number) => {
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2

        cr.save()
        cr.translate(offX, offY)
        cr.scale(scale, scale)
        Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
        cr.paint()
        cr.restore()

        // Darken everything outside the circle (even-odd punches the hole).
        cr.setSourceRGBA(0, 0, 0, 0.55)
        cr.rectangle(0, 0, w, h)
        cr.arc(cx, cy, r, 0, 2 * Math.PI)
        cr.setFillRule(Cairo.FillRule.EVEN_ODD)
        cr.fill()

        // Crisp ring on the crop boundary.
        cr.setSourceRGBA(1, 1, 1, 0.9)
        cr.setLineWidth(2)
        cr.arc(cx, cy, r - 1, 0, 2 * Math.PI)
        cr.stroke()
    })

    // ── Pan ─────────────────────────────────────────────────────────────────────
    const drag = new Gtk.GestureDrag()
    let startX = 0, startY = 0
    drag.connect("drag-begin", () => { startX = offX; startY = offY })
    drag.connect("drag-update", (_g: any, dx: number, dy: number) => {
        offX = startX + dx; offY = startY + dy
        clampOff(); area.queue_draw()
    })
    area.add_controller(drag)

    // ── Zoom (keeps the canvas-centre image point fixed) ──────────────────────────
    const setZoom = (z: number) => {
        const cx = DISPLAY / 2, cy = DISPLAY / 2
        const px = (cx - offX) / scale, py = (cy - offY) / scale
        scale = minScale * z
        offX = cx - px * scale
        offY = cy - py * scale
        clampOff(); area.queue_draw()
    }
    const zoomSlider = makeHSlider({
        min: 1, max: MAX_ZOOM, value: 1,
        onChange: setZoom,
        onValueChanged: setZoom,
        debounce: 0,
        cssClasses: ["cc-atomic-scale-native"],
    })
    ;(zoomSlider as any).hexpand = true

    // ── Dialog ────────────────────────────────────────────────────────────────────
    const dialog = new Gtk.Window({
        title: t("settings.users.avatar.crop.title"),
        modal: true,
        transient_for: parentWin ?? undefined,
        resizable: false,
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_start: 24, margin_end: 24, margin_top: 24, margin_bottom: 24,
    })

    const canvasWrap = new Gtk.Box({ halign: Gtk.Align.CENTER })
    canvasWrap.append(area)
    box.append(canvasWrap)

    box.append(new Gtk.Label({
        label: t("settings.users.avatar.crop.hint"),
        css_classes: ["crystal-row-subtitle"],
        halign: Gtk.Align.CENTER,
    }))

    const zoomRow = new Gtk.Box({ spacing: 10, hexpand: true })
    zoomRow.append(new Gtk.Image({ gicon: Icons.zoomOut, pixel_size: 20, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
    zoomRow.append(zoomSlider)
    zoomRow.append(new Gtk.Image({ gicon: Icons.zoomIn, pixel_size: 20, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER }))
    box.append(zoomRow)

    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END, margin_top: 4 })
    const cancelBtn = CrystalButton({ label: t("settings.users.other.cancel"), variant: "secondary", pill: true })
    const useBtn = CrystalButton({ label: t("settings.users.avatar.crop.use"), variant: "primary", pill: true })
    cancelBtn.connect("clicked", () => dialog.close())
    useBtn.connect("clicked", () => {
        // Crop the SOURCE (full quality) to the framed square, then scale to SAVE.
        const sx = Math.max(0, Math.round(-offX / scale))
        const sy = Math.max(0, Math.round(-offY / scale))
        let side = Math.round(DISPLAY / scale)
        side = Math.min(side, iw - sx, ih - sy)
        let out = pixbuf.new_subpixbuf(sx, sy, side, side)
        out = out.scale_simple(SAVE, SAVE, GdkPixbuf.InterpType.BILINEAR)
        dialog.close()
        onAccept(out)
    })
    btnRow.append(cancelBtn)
    btnRow.append(useBtn)
    box.append(btnRow)

    dialog.set_child(box)
    dialog.present()
}
