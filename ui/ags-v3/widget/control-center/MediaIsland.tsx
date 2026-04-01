import { Gtk, Gdk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { createSquirclePath } from "../common/DrawingUtils"
import { Shape } from "../common/SquircleContainer"
import { AtomicWidget, WidgetSize } from "./Types"

export function MediaIslandContent(): AtomicWidget {
    const mpris = AstalMpris.get_default()

    const mediaContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false
    })

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
        hexpand: false, vexpand: false
    })

    const title = new Gtk.Label({
        label: "No media",
        css_classes: ["cc-media-title-atomic"],
        halign: Gtk.Align.CENTER,
        ellipsize: 3,
        max_width_chars: 18,
        margin_top: 0
    })

    const artist = new Gtk.Label({
        label: "",
        css_classes: ["cc-media-artist-atomic"],
        halign: Gtk.Align.CENTER,
        ellipsize: 3,
        max_width_chars: 20,
        margin_top: 0
    })

    header.append(artDa)
    header.append(title)
    header.append(artist)

    const controls = new Gtk.Box({ halign: Gtk.Align.CENTER })

    const prev = new Gtk.Button({ icon_name: "media-skip-backward-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const play = new Gtk.Button({ icon_name: "media-playback-start-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const next = new Gtk.Button({ icon_name: "media-skip-forward-symbolic", css_classes: ["cc-media-btn-atomic"] })

    prev.set_size_request(32, 32); play.set_size_request(32, 32); next.set_size_request(32, 32)
    controls.append(prev); controls.append(play); controls.append(next)

    mediaContent.append(header)
    mediaContent.append(controls)

    let artPixbuf: any = null
    let currentPlayer: any = null
    let playerSignalId: number | null = null

    const updateDisplay = () => {
        const player = currentPlayer
        if (!player) {
            title.label = "No media"
            artist.label = ""
            artPixbuf = null
            play.icon_name = "media-playback-start-symbolic"
            prev.sensitive = false
            next.sensitive = false
            artDa.queue_draw()
            return
        }

        title.label = player.title || "No media"
        artist.label = player.artist || ""
        play.icon_name = player.playback_status === AstalMpris.PlaybackStatus.PLAYING
            ? "media-playback-pause-symbolic"
            : "media-playback-start-symbolic"

        prev.sensitive = player.can_go_previous !== false
        next.sensitive = player.can_go_next !== false

        const art = player.cover_art
        if (art && GLib.file_test(art, GLib.FileTest.EXISTS)) {
            try {
                artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(art, 64, 64, false)
            } catch { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    const update = () => {
        // Disconnect from old player's signals
        if (currentPlayer !== null && playerSignalId !== null) {
            try { currentPlayer.disconnect(playerSignalId) } catch {}
            playerSignalId = null
        }

        currentPlayer = mpris.get_players()[0] ?? null

        // Connect to the new player's property changes (title, status, cover art, etc.)
        if (currentPlayer) {
            playerSignalId = currentPlayer.connect("notify", updateDisplay)
        }

        updateDisplay()
    }

    artDa.set_draw_func((_, cr, w, h) => {
        if (artPixbuf) {
            cr.save(); createSquirclePath(cr, 0, 0, w, h, 14, 3.2); cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0); cr.paint(); cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 14, 3.2); cr.fill()
        }
    })

    // Wire control buttons
    prev.connect("clicked", () => { try { currentPlayer?.previous() } catch {} })
    play.connect("clicked", () => { try { currentPlayer?.play_pause() } catch {} })
    next.connect("clicked", () => { try { currentPlayer?.next() } catch {} })

    if (mpris) mpris.connect("notify::players", update)
    update()

    return { id: "media", name: "Media", size: WidgetSize.SQUARE, child: mediaContent }
}
