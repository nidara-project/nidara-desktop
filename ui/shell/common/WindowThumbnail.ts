import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"
import type Gdk from "gi://Gdk?version=4.0"

/**
 * Paints one captured window texture, clipped to a rounded rect.
 *
 * Why a snapshot widget and not Cairo: the schematic's tiles are drawn in a
 * Gtk.DrawingArea, and painting the capture there would mean `download()`ing the
 * texture back out of the GPU on every draw — the exact cost the capture design
 * set out to avoid. `append_texture()` keeps it on the GPU, and the rounded clip
 * is a GSK node rather than a post-process.
 *
 * The radius is set per-sync rather than in CSS because the schematic's corner
 * radius is DERIVED (Hyprland's rounding × the minimap scale): a fixed CSS radius
 * would drift from the Cairo tile underneath as soon as the monitor resolution
 * changed, and the mismatch shows as the tile's colour peeking out at the corners.
 */

/**
 * GJS can construct a Gsk.RoundedRect on every version we target, but it is a
 * plain struct with an init-style constructor and that is exactly the shape that
 * has broken across GJS releases before. Probed ONCE here, outside any snapshot:
 * a throw inside vfunc_snapshot would risk an unbalanced push/pop and take the
 * frame down, which is a far worse failure than square corners.
 */
const ROUNDED_CLIP_OK = (() => {
    try {
        const probe = new Gsk.RoundedRect()
        const rect = new Graphene.Rect()
        rect.init(0, 0, 1, 1)
        probe.init_from_rect(rect, 1)
        return true
    } catch (e) {
        console.warn(`[WindowThumbnail] no rounded clip available, corners will be square: ${e}`)
        return false
    }
})()

export class WindowThumbnail extends Gtk.Widget {
    static {
        GObject.registerClass({ GTypeName: "NidaraWindowThumbnail" }, this)
    }

    private texture: Gdk.Texture | null = null
    private radius = 0

    /** Swaps the painted texture. `null` clears it back to the placeholder. */
    setTexture(texture: Gdk.Texture | null) {
        if (this.texture === texture) return
        this.texture = texture
        this.queue_draw()
    }

    hasTexture(): boolean {
        return this.texture !== null
    }

    /** Corner radius in widget pixels — must match the Cairo tile beneath. */
    setRadius(radius: number) {
        const r = Math.max(0, radius)
        if (this.radius === r) return
        this.radius = r
        this.queue_draw()
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot) {
        const texture = this.texture
        if (!texture) return

        const w = this.get_width()
        const h = this.get_height()
        if (w <= 0 || h <= 0) return

        const bounds = new Graphene.Rect()
        bounds.init(0, 0, w, h)

        // Never round more than the box can carry, or GSK draws a lozenge on the
        // narrow slivers that tiled windows produce at minimap scale.
        const r = Math.min(this.radius, w / 2, h / 2)
        const rounded = ROUNDED_CLIP_OK && r > 0

        if (rounded) {
            const clip = new Gsk.RoundedRect()
            clip.init_from_rect(bounds, r)
            snapshot.push_rounded_clip(clip)
        }
        snapshot.append_texture(texture, bounds)
        if (rounded) snapshot.pop()
    }
}

/** Constructed through a helper so callers never touch GObject registration. */
export function makeWindowThumbnail(): WindowThumbnail {
    return new WindowThumbnail()
}
