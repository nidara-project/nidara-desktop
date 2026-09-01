import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { makeCoverArt } from "../../common/CoverArt"
import { CCWidgetSpec, WidgetSize } from "../../common/widget-kit"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { safeDisconnect } from "../../core/signals"
import * as media from "../../core/MediaService"

// Player + text state only. The ARTWORK is not here: every tile's art is a
// `makeCoverArt` from common/, which owns its own decode, its own path guard and
// its own redraw — which is what the `artVersion` counter this state used to carry
// was for (tiles compared it to skip a queue_draw for a "notify" that was about a
// title or a can-go-next).
interface MediaState {
    currentPlayer: any
    listeners: Array<() => void>
    notify: () => void
}

function makeMediaState(): MediaState {
    const state: MediaState = {
        currentPlayer: null,
        listeners: [],
        notify: () => state.listeners.forEach(fn => fn()),
    }

    let playerSignalId: number | null = null

    const updatePlayer = () => {
        if (state.currentPlayer && playerSignalId !== null) {
            safeDisconnect(state.currentPlayer, playerSignalId)
            playerSignalId = null
        }
        state.currentPlayer = media.selectedPlayer()
        if (state.currentPlayer)
            playerSignalId = state.currentPlayer.connect("notify", () => state.notify())
        state.notify()
    }

    // MediaService fires on selection changes AND async art arrivals (module
    // lifetime — the shared state below is a singleton, so no unsubscribe path).
    media.subscribe(updatePlayer)
    updatePlayer()

    return state
}

// SQUARE (2×2): artwork + title/artist + prev/play/next
function buildSquareContent(state: MediaState): Gtk.Widget {
    const artDa = makeCoverArt({ size: 62, shape: 15 })
    Object.assign(artDa, {
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        margin_bottom: 2, // breathing room between artwork and title
    })

    // Two lines + word-char wrap so longer titles use the space below the artwork.
    // CRITICAL: the tile lives in a Gtk.Fixed, which does NO height-for-width — a
    // wrapping label measures as 1 line then paints 2, causing phantom slack + overflow.
    // width_request pins the wrap width; height_request reserves the 2-line height
    // unconditionally, so the parent always allocates enough regardless of measurement.
    const title = new Gtk.Label({
        label: t("cc.media.no-media"), css_classes: ["nidara-media-title"],
        halign: Gtk.Align.CENTER, justify: Gtk.Justification.CENTER,
        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: 3,
        width_request: 140, height_request: 36,
    })
    const artist = new Gtk.Label({
        label: "", css_classes: ["nidara-media-artist"],
        halign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 20,
    })

    const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.CENTER })
    header.append(artDa); header.append(title); header.append(artist)

    const controls = new Gtk.Box({ halign: Gtk.Align.CENTER, spacing: 16, margin_top: 4 })
    const prevImg = new Gtk.Image({ gicon: Icons.skipBack,    pixel_size: 18 , css_classes: ["nd-icon"] })
    const playImg = new Gtk.Image({ gicon: Icons.play,        pixel_size: 18 , css_classes: ["nd-icon"] })
    const nextImg = new Gtk.Image({ gicon: Icons.skipForward, pixel_size: 18 , css_classes: ["nd-icon"] })
    const prev = new Gtk.Button({ child: prevImg, css_classes: ["nidara-media-btn"] })
    const play = new Gtk.Button({ child: playImg, css_classes: ["nidara-media-btn"] })
    const next = new Gtk.Button({ child: nextImg, css_classes: ["nidara-media-btn"] })
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

    // Labels/sensitive are equality-guarded by GTK; gicon is NOT (reassigning the
    // same icon forces a redraw — tech-debt #11C), and queue_draw is gated on the
    // art version so the 1 Hz position notify does zero work.
    const update = () => {
        const p = state.currentPlayer
        title.label  = p?.title || t("cc.media.no-media")
        artist.label = p?.artist || ""
        const wantPlay = p?.playback_status === media.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
        if (playImg.gicon !== wantPlay) playImg.gicon = wantPlay
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next !== false
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
    const artDa = makeCoverArt({ size: 44, shape: 10 })
    artDa.halign = Gtk.Align.CENTER
    artDa.valign = Gtk.Align.CENTER

    const title  = new Gtk.Label({ label: t("cc.media.no-media"), css_classes: ["nidara-media-title"],  halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const artist = new Gtk.Label({ label: "",         css_classes: ["nidara-media-artist"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    textBox.append(title); textBox.append(artist)

    const widePlayImg = new Gtk.Image({ gicon: Icons.play, pixel_size: 18 , css_classes: ["nd-icon"] })
    const play = new Gtk.Button({ child: widePlayImg, css_classes: ["nidara-media-btn"], valign: Gtk.Align.CENTER })
    play.set_size_request(32, 32)

    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, margin_start: 4, margin_end: 4,
    })
    row.append(artDa); row.append(textBox); row.append(play)

    const update = () => {
        const p = state.currentPlayer
        title.label  = p?.title || t("cc.media.no-media")
        artist.label = p?.artist || ""
        const wantPlay = p?.playback_status === media.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
        if (widePlayImg.gicon !== wantPlay) widePlayImg.gicon = wantPlay
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
function buildSingleContent(): Gtk.Widget {
    const fallback = new Gtk.Image({
        gicon: Icons.play, pixel_size: 22, css_classes: ["nd-icon"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    })

    // The play glyph shows THROUGH the empty circle, so it is the ARTWORK that
    // decides its visibility — the painter says whether there is any (a path that
    // fails to decode counts as none). Nothing else on this tile has state, which is
    // why it is the one size that needs no listener on the shared player state.
    const artDa = makeCoverArt({ shape: "circle", onArt: (has) => { fallback.visible = !has } })

    const overlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
    overlay.set_child(artDa)
    overlay.add_overlay(fallback)
    return overlay
}

// ONE shared state for every media tile instance: buildContent re-runs on each
// CC layout/size rebuild, and a per-call state leaked its player subscription
// (and re-decoded the artwork) every time. The per-widget update listeners
// still detach themselves on unrealize.
let sharedState: MediaState | null = null

export function MediaIslandContent(): CCWidgetSpec {
    const state = (sharedState ??= makeMediaState())

    return {
        id: "media",
        name: t("cc.media.name"),
        defaultSize: WidgetSize.SQUARE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
        buildContent: (size) =>
            size === WidgetSize.WIDE   ? buildWideContent(state)   :
            size === WidgetSize.SINGLE ? buildSingleContent() :
                                         buildSquareContent(state),
    }
}
