import { Gtk, Gdk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { createSquirclePath } from "../common/DrawingUtils"
import { Shape } from "../common/SquircleContainer"
import { AtomicWidget } from "./Types"

export function MediaIslandContent(grid: { x: number, y: number }): AtomicWidget {
    const mpris = AstalMpris.get_default()

    const mediaContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["cc-media-content"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: false
    })

    const artDa = new Gtk.DrawingArea({ css_classes: ["cc-media-art-da"], valign: Gtk.Align.CENTER, width_request: 90, height_request: 45, halign: Gtk.Align.CENTER })
    const title = new Gtk.Label({ label: "No media", css_classes: ["cc-media-title-atomic"], halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 18 })
    const artist = new Gtk.Label({ label: "", css_classes: ["cc-media-artist-atomic"], halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 20 })

    mediaContent.append(artDa)
    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    textStack.append(title)
    textStack.append(artist)
    mediaContent.append(textStack)

    const controls = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER, css_classes: ["cc-media-controls-atomic"] })
    const prev = new Gtk.Button({ icon_name: "media-skip-backward-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const play = new Gtk.Button({ icon_name: "media-playback-start-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const next = new Gtk.Button({ icon_name: "media-skip-forward-symbolic", css_classes: ["cc-media-btn-atomic"] })
    controls.append(prev); controls.append(play); controls.append(next)
    mediaContent.append(controls)

    let lastPlayer: AstalMpris.Player | null = null
    let playerSignals: number[] = []
    let artPixbuf: any = null

    const update = () => {
        const players = mpris.get_players()
        if (players.length === 0) {
            title.label = "No media"
            artist.label = ""
            if (lastPlayer) { playerSignals.forEach(id => lastPlayer?.disconnect(id)); playerSignals = []; lastPlayer = null }
            artPixbuf = null; artDa.queue_draw()
            return
        }

        const player = players[0]
        if (lastPlayer !== player) {
            if (lastPlayer) { playerSignals.forEach(id => lastPlayer?.disconnect(id)); playerSignals = [] }
            lastPlayer = player
            playerSignals.push(player.connect("notify::playback-status", update))
            playerSignals.push(player.connect("notify::title", update))
            playerSignals.push(player.connect("notify::artist", update))
            playerSignals.push(player.connect("notify::cover-art", update))
        }

        title.label = player.title || "Unknown Title"
        artist.label = player.artist || "Unknown Artist"
        play.icon_name = player.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic"

        prev.connect("clicked", () => player.previous())
        play.connect("clicked", () => player.play_pause())
        next.connect("clicked", () => player.next())

        if (player.cover_art && GLib.file_test(player.cover_art, GLib.FileTest.EXISTS)) {
            try {
                artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(player.cover_art, 90, 90, true)
            } catch (e) { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    artDa.set_draw_func((_, cr, w, h) => {
        if (artPixbuf) {
            cr.save()
            createSquirclePath(cr, 0, 0, w, h, 20, 4.5)
            cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0)
            cr.paint()
            cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 20, 4.5); cr.fill()
        }
    })

    if (mpris) {
        mpris.connect("notify::players", update)
        update()
    }

    return {
        id: "media",
        name: "Media",
        grid: { ...grid, w: 2, h: 2 },
        shape: Shape.SQUIRCLE,
        child: mediaContent
    }
}
