import type Gtk from "gi://Gtk?version=4.0"
import type Gdk from "gi://Gdk?version=4.0"
import type Gsk from "gi://Gsk?version=4.0"
import Graphene from "gi://Graphene"

/**
 * Append a SCALED texture without it being rendered at scale 1 first.
 *
 * `Gtk.Snapshot.append_scaled_texture` makes a texture-scale node, and GTK's GPU renderer
 * draws that node through an OFFSCREEN whenever the current scale is not exactly 1
 * (`gsk_gpu_node_processor_add_texture_scale_node`: `need_offscreen = … || scale != 1`),
 * and that offscreen is created at a scale of (1, 1) — the node's LOGICAL size. On a
 * scale-2 screen every such texture was therefore rasterised at half resolution and
 * stretched back up: the dock's icons and its glass capsule were soft at rest and
 * magnified, while a Gtk.Image (a plain texture node, no scaling filter) was sharp next
 * to them (owner-caught 2026-09-26; A/B'd live by swapping the dock's icons for Gtk.Image).
 *
 * The way round it is to draw in DEVICE space: undo the surface scale on the snapshot,
 * so the renderer's scale is 1 and the node goes straight to the framebuffer, and give
 * the rect in device pixels. `rect` is in the widget's LOGICAL coordinates; it is
 * multiplied here.
 */
export function appendScaledTextureDevice(
    snapshot: Gtk.Snapshot,
    scale: number,
    texture: Gdk.Texture,
    filter: Gsk.ScalingFilter,
    rect: Graphene.Rect,
): void {
    appendScaledTextureDevicePx(snapshot, scale, texture, filter,
        rect.get_x() * scale, rect.get_y() * scale, rect.get_width() * scale, rect.get_height() * scale)
}

/** Same, with the rect already in DEVICE pixels (for callers that snap to them). */
export function appendScaledTextureDevicePx(
    snapshot: Gtk.Snapshot,
    scale: number,
    texture: Gdk.Texture,
    filter: Gsk.ScalingFilter,
    x: number, y: number, width: number, height: number,
): void {
    const r = new Graphene.Rect()
    r.init(x, y, width, height)
    snapshot.save()
    snapshot.scale(1 / scale, 1 / scale)
    snapshot.append_scaled_texture(texture, filter, r)
    snapshot.restore()
}

/** The scale the widget's surface is RENDERED at — fractional (1.25 stays 1.25), unlike
 *  `get_scale_factor()`, which rounds up to the next integer. */
export function surfaceScale(widget: Gtk.Widget): number {
    return widget.get_native()?.get_surface()?.get_scale() || widget.get_scale_factor() || 1
}
