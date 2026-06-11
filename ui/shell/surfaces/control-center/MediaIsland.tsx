import { Gtk, Gdk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Pango from "gi://Pango"
import { createSquirclePath } from "../../common/DrawingUtils"
import { AtomicWidget, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

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
    const artDa = new Gtk.DrawingArea({
        width_request: 62, height_request: 62,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false,
        margin_bottom: 2, // breathing room between artwork and title
    })

    // Two lines + word-char wrap so longer titles use the space below the artwork.
    // CRITICAL: the tile lives in a Gtk.Fixed, which does NO height-for-width — a
    // wrapping label measures as 1 line then paints 2, causing phantom slack + overflow.
    // width_request pins the wrap width; height_request reserves the 2-line height
    // unconditionally, so the parent always allocates enough regardless of measurement.
    const title = new Gtk.Label({
        label: t("cc.media.no-media"), css_classes: ["cc-media-title-atomic"],
        halign: Gtk.Align.CENTER, justify: Gtk.Justification.CENTER,
        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: 3,
        width_request: 140, height_request: 36,
    })
    const artist = new Gtk.Label({
        label: "", css_classes: ["cc-media-artist-atomic"],
        halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 20,
    })

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.CENTER })
    header.append(artDa); header.append(title); header.append(artist)

    const controls = new Gtk.Box({ halign: Gtk.Align.CENTER, spacing: 18, margin_top: 4 })
    const prevImg = new Gtk.Image({ gicon: Icons.skipBack,    pixel_size: 18 , css_classes: ["cs-icon"] })
    const playImg = new Gtk.Image({ gicon: Icons.play,        pixel_size: 18 , css_classes: ["cs-icon"] })
    const nextImg = new Gtk.Image({ gicon: Icons.skipForward, pixel_size: 18 , css_classes: ["cs-icon"] })
    const prev = new Gtk.Button({ child: prevImg, css_classes: ["cc-media-btn-atomic"] })
    const play = new Gtk.Button({ child: playImg, css_classes: ["cc-media-btn-atomic"] })
    const next = new Gtk.Button({ child: nextImg, css_classes: ["cc-media-btn-atomic"] })
    prev.set_size_request(24, 24); play.set_size_request(24, 24); next.set_size_request(24, 24)
    controls.append(prev); controls.append(play); controls.append(next)

    // BaseIsland forces the returned widget to valign=FILL, so the box stretches to
    // the full tile. valign=CENTER on a vexpanding child is ignored (it fills instead),
    // which top-packed the content and pooled slack below the controls. Two equal
    // vexpand spacers above and below split the leftover space 50/50 → the group is
    // genuinely centred, and they collapse to 0 cleanly if the content ever overflows.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    box.append(new Gtk.Box({ vexpand: true }))
    box.append(header)
    box.append(controls)
    box.append(new Gtk.Box({ vexpand: true }))

    artDa.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        if (state.artPixbuf) {
            const small = state.artPixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR)
            cr.save(); createSquirclePath(cr, 0, 0, w, h, 15, 3.2); cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, small, 0, 0); cr.paint(); cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1); createSquirclePath(cr, 0, 0, w, h, 15, 3.2); cr.fill()
        }
    })

    const update = () => {
        const p = state.currentPlayer
        title.label  = p?.title || t("cc.media.no-media")
        artist.label = p?.artist || ""
        playImg.gicon = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
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
        if (w <= 0 || h <= 0) return
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

    const widePlayImg = new Gtk.Image({ gicon: Icons.play, pixel_size: 18 , css_classes: ["cs-icon"] })
    const play = new Gtk.Button({ child: widePlayImg, css_classes: ["cc-media-btn-atomic"], valign: Gtk.Align.CENTER })
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
        widePlayImg.gicon = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
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

// SINGLE (1×1): just the cover art, clipped to a circle to sit inside the round
// island (with a play-glyph fallback when nothing is playing). Tap opens the detail
// panel, like the other 1×1 status tiles.
function buildSingleContent(state: MediaState): Gtk.Widget {
    const artDa = new Gtk.DrawingArea({ hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })
    artDa.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const d = Math.min(w, h)
        const x = (w - d) / 2, y = (h - d) / 2
        cr.save()
        cr.arc(x + d / 2, y + d / 2, d / 2, 0, 2 * Math.PI)
        cr.clip()
        if (state.artPixbuf) {
            const small = state.artPixbuf.scale_simple(d, d, GdkPixbuf.InterpType.BILINEAR)
            Gdk.cairo_set_source_pixbuf(cr, small, x, y)
            cr.paint()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.1)
            cr.paint()
        }
        cr.restore()
    })

    const fallback = new Gtk.Image({
        gicon: Icons.play, pixel_size: 22, css_classes: ["cs-icon"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    })

    const overlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
    overlay.set_child(artDa)
    overlay.add_overlay(fallback)

    const update = () => {
        fallback.visible = !state.artPixbuf
        artDa.queue_draw()
    }

    state.listeners.push(update)
    overlay.connect("unrealize", () => {
        const i = state.listeners.indexOf(update)
        if (i >= 0) state.listeners.splice(i, 1)
    })
    update()
    return overlay
}

export function MediaIslandContent(): AtomicWidget {
    const state = makeMediaState()

    return {
        id: "media",
        name: t("cc.media.name"),
        defaultSize: WidgetSize.SQUARE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
        buildContent: (size) =>
            size === WidgetSize.WIDE   ? buildWideContent(state)   :
            size === WidgetSize.SINGLE ? buildSingleContent(state) :
                                         buildSquareContent(state),
    }
}
