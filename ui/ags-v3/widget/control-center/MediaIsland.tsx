import { Gtk, Gdk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { createSquirclePath } from "../common/DrawingUtils"
import { Shape } from "../common/SquircleContainer"
import { AtomicWidget, WidgetSize } from "./Types"

/**
 *  Media Island - ARCHITECTURAL COLLISION FIX
 * 
 * - Fixed the "Square bottom" image issue (DrawingArea expansion fix)
 * - Fixed the "Gap" issue (Negative overlap to kill font padding)
 * - Fixed "Title Cut" (Allowed more chars since buttons are wide)
 */
export function MediaIslandContent(): AtomicWidget {
    const mpris = AstalMpris.get_default()

    const mediaContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false // 🔒 NO EXPANSION ALLOWED
    })

    // Header Group: Image + Text glued tightly
    const header = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        halign: Gtk.Align.CENTER
    })

    const artDa = new Gtk.DrawingArea({
        css_classes: ["cc-media-art-da"],
        width_request: 64,
        height_request: 64,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false // 🔒 CRITICAL: prevents "square bottom" 
    })

    const title = new Gtk.Label({
        label: "No media",
        css_classes: ["cc-media-title-atomic"],
        halign: Gtk.Align.CENTER,
        ellipsize: 3,
        max_width_chars: 18, // 🔓 Increased since buttons are wide anyway
        margin_top: -6 // 📐 Kills the font's internal top air
    })

    const artist = new Gtk.Label({
        label: "",
        css_classes: ["cc-media-artist-atomic"],
        halign: Gtk.Align.CENTER,
        ellipsize: 3,
        max_width_chars: 20,
        margin_top: -2 // 📐 Kills gap between title and artist
    })

    header.append(artDa)
    header.append(title)
    header.append(artist)

    const controls = new Gtk.Box({
        spacing: 10,
        halign: Gtk.Align.CENTER,
        margin_top: 14 // Controlled air between artist and buttons
    })

    const prev = new Gtk.Button({ icon_name: "media-skip-backward-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const play = new Gtk.Button({ icon_name: "media-playback-start-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const next = new Gtk.Button({ icon_name: "media-skip-forward-symbolic", css_classes: ["cc-media-btn-atomic"] })

    // Fixed sizes
    prev.set_size_request(32, 32); play.set_size_request(32, 32); next.set_size_request(32, 32)
    controls.append(prev); controls.append(play); controls.append(next)

    mediaContent.append(header)
    mediaContent.append(controls)

    let artPixbuf: any = null

    const update = () => {
        const player = mpris.get_players()[0]
        if (!player) {
            title.label = "No media"; artist.label = ""; artPixbuf = null; artDa.queue_draw()
            return
        }

        title.label = player.title || "No media"
        artist.label = player.artist || ""
        play.icon_name = player.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic"

        if (player.cover_art && GLib.file_test(player.cover_art, GLib.FileTest.EXISTS)) {
            try {
                //  Force 64x64 ignore ratio to avoid empty space inside the squircle
                artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(player.cover_art, 64, 64, false)
            } catch (e) { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    artDa.set_draw_func((_, cr, w, h) => {
        if (artPixbuf) {
            cr.save(); createSquirclePath(cr, 0, 0, w, h, 14, 4.5); cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0); cr.paint(); cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 14, 4.5); cr.fill()
        }
    })

    if (mpris) mpris.connect("notify::players", update)
    update()

    return { id: "media", name: "Media", size: WidgetSize.SQUARE, child: mediaContent }
}
