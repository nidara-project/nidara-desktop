import { Gtk, Gdk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { createSquirclePath } from "../common/DrawingUtils"
import { AtomicWidget, WidgetSize } from "./Types"
import { t } from "../../core/i18n"

interface MediaState {
    artPixbuf: any
    currentPlayer: any
    listeners: Array<() => void>
    notify: () => void
}

function makeMediaState(): MediaState {
    const state: MediaState = {
        artPixbuf: null,
        currentPlayer: null,
        listeners: [],
        notify: () => state.listeners.forEach(fn => fn()),
    }

    const mpris = AstalMpris.get_default()
    let playerSignalId: number | null = null

    const updatePlayer = () => {
        if (state.currentPlayer && playerSignalId !== null) {
            try { state.currentPlayer.disconnect(playerSignalId) } catch {}
            playerSignalId = null
        }
        state.currentPlayer = mpris?.get_players()[0] ?? null
        if (state.currentPlayer) {
            playerSignalId = state.currentPlayer.connect("notify", () => {
                loadArt()
                state.notify()
            })
        }
        loadArt()
        state.notify()
    }

    const loadArt = () => {
        const art = state.currentPlayer?.cover_art
        if (art && GLib.file_test(art, GLib.FileTest.EXISTS)) {
            try { state.artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(art, 64, 64, false) }
            catch { state.artPixbuf = null }
        } else { state.artPixbuf = null }
    }

    if (mpris) mpris.connect("notify::players", updatePlayer)
    updatePlayer()

    return state
}

// SQUARE (2×2): artwork + title/artist + prev/play/next
function buildSquareContent(state: MediaState): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false,
    })

    const artDa = new Gtk.DrawingArea({
        width_request: 64, height_request: 64,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false,
    })

    const title = new Gtk.Label({
        label: t("cc.media.no-media"), css_classes: ["cc-media-title-atomic"],
        halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 18,
    })
    const artist = new Gtk.Label({
        label: "", css_classes: ["cc-media-artist-atomic"],
        halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 20,
    })

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, halign: Gtk.Align.CENTER })
    header.append(artDa); header.append(title); header.append(artist)

    const controls = new Gtk.Box({ halign: Gtk.Align.CENTER })
    const prev = new Gtk.Button({ icon_name: "media-skip-backward-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const play = new Gtk.Button({ icon_name: "media-playback-start-symbolic", css_classes: ["cc-media-btn-atomic"] })
    const next = new Gtk.Button({ icon_name: "media-skip-forward-symbolic",  css_classes: ["cc-media-btn-atomic"] })
    prev.set_size_request(32, 32); play.set_size_request(32, 32); next.set_size_request(32, 32)
    controls.append(prev); controls.append(play); controls.append(next)

    box.append(header); box.append(controls)

    artDa.set_draw_func((_, cr, w, h) => {
        if (state.artPixbuf) {
            cr.save(); createSquirclePath(cr, 0, 0, w, h, 14, 3.2); cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, state.artPixbuf, 0, 0); cr.paint(); cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 14, 3.2); cr.fill()
        }
    })

    const update = () => {
        const p = state.currentPlayer
        title.label  = p?.title || t("cc.media.no-media")
        artist.label = p?.artist || ""
        play.icon_name = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING
            ? "media-playback-pause-symbolic" : "media-playback-start-symbolic"
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next !== false
        artDa.queue_draw()
    }

    prev.connect("clicked", () => { try { state.currentPlayer?.previous()   } catch {} })
    play.connect("clicked", () => { try { state.currentPlayer?.play_pause() } catch {} })
    next.connect("clicked", () => { try { state.currentPlayer?.next()       } catch {} })

    state.listeners.push(update)
    box.connect("unrealize", () => {
        const i = state.listeners.indexOf(update)
        if (i >= 0) state.listeners.splice(i, 1)
    })
    update()
    return box
}

// WIDE (2×1): small artwork + title/artist + play only
function buildWideContent(state: MediaState): Gtk.Widget {
    const artDa = new Gtk.DrawingArea({
        width_request: 44, height_request: 44,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false,
    })
    artDa.set_draw_func((_, cr, w, h) => {
        if (state.artPixbuf) {
            const small = state.artPixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR)
            cr.save(); createSquirclePath(cr, 0, 0, w, h, 10, 3.2); cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, small, 0, 0); cr.paint(); cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 10, 3.2); cr.fill()
        }
    })

    const title  = new Gtk.Label({ label: "No media", css_classes: ["cc-media-title-atomic"],  halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const artist = new Gtk.Label({ label: "",         css_classes: ["cc-media-artist-atomic"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    textBox.append(title); textBox.append(artist)

    const play = new Gtk.Button({ icon_name: "media-playback-start-symbolic", css_classes: ["cc-media-btn-atomic"], valign: Gtk.Align.CENTER })
    play.set_size_request(32, 32)

    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, margin_start: 4, margin_end: 4,
    })
    row.append(artDa); row.append(textBox); row.append(play)

    const update = () => {
        const p = state.currentPlayer
        title.label  = p?.title || t("cc.media.no-media")
        artist.label = p?.artist || ""
        play.icon_name = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING
            ? "media-playback-pause-symbolic" : "media-playback-start-symbolic"
        artDa.queue_draw()
    }

    play.connect("clicked", () => { try { state.currentPlayer?.play_pause() } catch {} })

    state.listeners.push(update)
    row.connect("unrealize", () => {
        const i = state.listeners.indexOf(update)
        if (i >= 0) state.listeners.splice(i, 1)
    })
    update()
    return row
}

export function MediaIslandContent(): AtomicWidget {
    const state = makeMediaState()

    return {
        id: "media",
        name: t("cc.media.name"),
        defaultSize: WidgetSize.SQUARE,
        supportedSizes: [WidgetSize.SQUARE, WidgetSize.WIDE],
        buildContent: (size) => size === WidgetSize.WIDE
            ? buildWideContent(state)
            : buildSquareContent(state),
    }
}
