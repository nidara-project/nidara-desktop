import { Gtk, Gdk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Pango from "gi://Pango"
import { MediaIslandContent } from "../surfaces/control-center/MediaIsland"
import { createSquirclePath } from "../common/DrawingUtils"
import { makeHSlider } from "../common/Slider"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

function buildBarContent(): Gtk.Widget {
    const mpris = AstalMpris.get_default()

    const prevImg = new Gtk.Image({ gicon: Icons.skipBack,    pixel_size: 16 , css_classes: ["nd-icon"] })
    const playImg = new Gtk.Image({ gicon: Icons.play,        pixel_size: 16 , css_classes: ["nd-icon"] })
    const nextImg = new Gtk.Image({ gicon: Icons.skipForward, pixel_size: 16 , css_classes: ["nd-icon"] })
    const prev = new Gtk.Button({ child: prevImg, css_classes: ["bar-media-btn"] })
    const play = new Gtk.Button({ child: playImg, css_classes: ["bar-media-btn"] })
    const next = new Gtk.Button({ child: nextImg, css_classes: ["bar-media-btn"] })

    const title = new Gtk.Label({
        label: "",
        css_classes: ["bar-widget-label"],
        max_width_chars: 16,
        ellipsize: 3,
        visible: false,
    })

    const box = new Gtk.Box({
        spacing: 4,
        valign: Gtk.Align.CENTER,
        margin_start: 16,
        margin_end: 16,
    })
    box.append(prev)
    box.append(play)
    box.append(next)
    box.append(title)

    let player: any = null
    let playerSigId: number | null = null

    const update = () => {
        const p = player
        const playing = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING
        // AstalMpris polls position every 1s while PLAYING and emits notify::position,
        // firing this generic "notify" handler 1×/s. Guard the gicon assignment so an
        // unchanged play/pause icon never queues a draw → no 1 Hz bar re-blur while
        // music plays. (label/sensitive/visible below are already GTK equality-guarded.)
        const wantIcon = playing ? Icons.pause : Icons.play
        if (playImg.gicon !== wantIcon) playImg.gicon = wantIcon
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next !== false
        const t = p?.title || ""
        title.label = t
        title.visible = t.length > 0
    }

    const updatePlayer = () => {
        if (player && playerSigId !== null) {
            try { player.disconnect(playerSigId) } catch {}
            playerSigId = null
        }
        player = mpris?.get_players()[0] ?? null
        if (player) playerSigId = player.connect("notify", update)
        update()
    }

    if (mpris) {
        const mprisId = mpris.connect("notify::players", updatePlayer)
        box.connect("unrealize", () => {
            try { mpris.disconnect(mprisId) } catch {}
            if (playerSigId !== null && player) try { player.disconnect(playerSigId) } catch {}
        })
    }

    prev.connect("clicked", () => { try { player?.previous() } catch {} })
    play.connect("clicked", () => { try { player?.play_pause() } catch {} })
    next.connect("clicked", () => { try { player?.next() } catch {} })

    updatePlayer()
    return box
}

// Hours-aware time formatter shared by bar expanded and CC detail
function fmt(secs: number): string {
    const s = Math.max(0, Math.floor(secs))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`
}

// Shared rich player panel used by both bar expanded and CC detail.
// Progress is expressed as 0-100% so makeHSlider's range never needs to change.
function buildDetailPanel(widthRequest: number): Gtk.Widget {
    const mpris = AstalMpris.get_default()
    let player: any = null
    let playerSigId: number | null = null
    let progressTimer: number | null = null
    let artPixbuf: any = null
    let progressUpdateCb: ((pct: number) => void) | null = null

    const ART_SIZE = 96

    const artDa = new Gtk.DrawingArea({
        width_request: ART_SIZE, height_request: ART_SIZE,
        halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
        hexpand: false, vexpand: false,
    })
    artDa.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        if (artPixbuf) {
            cr.save()
            createSquirclePath(cr, 0, 0, w, h, 14, 3.2)
            cr.clip()
            Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0)
            cr.paint()
            cr.restore()
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.08)
            createSquirclePath(cr, 0, 0, w, h, 14, 3.2)
            cr.fill()
        }
    })

    // Wrap to up to 2 lines (uses the width to the right of the artwork) and only
    // ellipsize if the title still overflows two lines.
    const titleLabel = new Gtk.Label({
        label: t("cc.media.no-media"), css_classes: ["cc-media-title-atomic"],
        halign: Gtk.Align.START, hexpand: true, xalign: 0,
        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: 3,
        max_width_chars: 30,
    })
    const artistLabel = new Gtk.Label({
        label: "", css_classes: ["cc-media-artist-atomic"],
        halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 26,
    })

    const prevImg = new Gtk.Image({ gicon: Icons.skipBack,    pixel_size: 16, css_classes: ["nd-icon"] })
    const playImg = new Gtk.Image({ gicon: Icons.play,        pixel_size: 20, css_classes: ["nd-icon"] })
    const nextImg = new Gtk.Image({ gicon: Icons.skipForward, pixel_size: 16, css_classes: ["nd-icon"] })
    const prev = new Gtk.Button({ child: prevImg, css_classes: ["cc-media-btn-atomic"], valign: Gtk.Align.CENTER })
    const play = new Gtk.Button({ child: playImg, css_classes: ["cc-media-btn-atomic", "cc-media-play-btn"], valign: Gtk.Align.CENTER })
    const next = new Gtk.Button({ child: nextImg, css_classes: ["cc-media-btn-atomic"], valign: Gtk.Align.CENTER })
    prev.set_size_request(32, 32); play.set_size_request(36, 36); next.set_size_request(32, 32)

    const ctrlBox = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER, hexpand: true })
    ctrlBox.append(prev); ctrlBox.append(play); ctrlBox.append(next)

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, valign: Gtk.Align.CENTER, hexpand: true })
    textBox.append(titleLabel)
    textBox.append(artistLabel)

    const topRow = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    topRow.append(artDa)
    topRow.append(textBox)

    const elapsedLabel = new Gtk.Label({ label: "0:00", css_classes: ["cc-media-time"], halign: Gtk.Align.START })
    const totalLabel   = new Gtk.Label({ label: "--:--", css_classes: ["cc-media-time"], halign: Gtk.Align.END, hexpand: true })
    const timeRow = new Gtk.Box()
    timeRow.append(elapsedLabel); timeRow.append(totalLabel)

    // Cairo slider — no GTK thumb/margin issues, track and thumb always aligned.
    // Progress as 0-100% so the range never changes between tracks.
    const progressSlider = makeHSlider({
        min: 0, max: 100, value: 0, debounce: 200,
        trackH: 4, thumbR: 7,
        onChange: (pct) => {
            const len = player?.length || 0
            if (len > 0 && player?.can_seek !== false) try { player.position = (pct / 100) * len } catch {}
        },
        onValueChanged: (pct) => {
            const len = player?.length || 0
            elapsedLabel.label = fmt((pct / 100) * len)
        },
        onExtChange: (cb) => {
            progressUpdateCb = cb
            return () => { progressUpdateCb = null }
        },
    })

    // Progress bar + its time labels read as one unit, so group them tightly.
    const progressBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true })
    progressBox.append(progressSlider)
    progressBox.append(timeRow)

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true,
        margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
    })
    if (widthRequest > 0) root.set_size_request(widthRequest, -1)
    // Order: artwork+title → progress (with times) → transport controls.
    root.append(topRow)
    root.append(progressBox)
    root.append(ctrlBox)

    const syncProgress = () => {
        const len = player?.length || 0
        const pos = player?.position || 0
        const pct = len > 0 ? (pos / len) * 100 : 0
        progressUpdateCb?.(pct)
        elapsedLabel.label = fmt(pos)
        totalLabel.label = len > 0 ? fmt(len) : "--:--"
    }

    const loadArt = () => {
        const art = player?.cover_art
        if (art && GLib.file_test(art, GLib.FileTest.EXISTS)) {
            try { artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(art, ART_SIZE, ART_SIZE, false) }
            catch { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    const update = () => {
        const p = player
        titleLabel.label  = p?.title  || t("cc.media.no-media")
        artistLabel.label = p?.artist || ""
        playImg.gicon = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next    !== false
        loadArt()
        syncProgress()
    }

    // The 1 Hz progress tick only runs while the panel is both mapped and has a
    // player — built-once-hidden surfaces must not keep session-long timers.
    const startTimer = () => {
        if (progressTimer !== null || !root.get_mapped()) return
        progressTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!player || !root.get_mapped()) { progressTimer = null; return GLib.SOURCE_REMOVE }
            syncProgress()
            return GLib.SOURCE_CONTINUE
        })
    }

    root.connect("map", () => { if (player) { syncProgress(); startTimer() } })

    const updatePlayer = () => {
        if (player && playerSigId !== null) { try { player.disconnect(playerSigId) } catch {} ; playerSigId = null }
        player = mpris?.get_players()[0] ?? null
        if (player) { playerSigId = player.connect("notify", update); startTimer() }
        update()
    }

    prev.connect("clicked", () => { try { player?.previous()   } catch {} })
    play.connect("clicked", () => { try { player?.play_pause() } catch {} })
    next.connect("clicked", () => { try { player?.next()       } catch {} })

    if (mpris) {
        const mprisId = mpris.connect("notify::players", updatePlayer)
        root.connect("unrealize", () => {
            try { mpris.disconnect(mprisId) } catch {}
            if (playerSigId !== null && player) try { player.disconnect(playerSigId) } catch {}
            if (progressTimer !== null) { try { GLib.source_remove(progressTimer) } catch {} ; progressTimer = null }
        })
    }

    updatePlayer()
    return root
}

// Bar pill expansion: same rich panel, fixed width to match CC detail squircle
function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    return buildDetailPanel(PANEL_W.full)
}

function buildCCDetail(_onClose: () => void): Gtk.Widget {
    return buildDetailPanel(0)
}

const mediaWidget: AtomicWidget = {
    id: "media",
    category: "media",
    name: t("cc.media.name"),
    icon: Icons.play,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SQUARE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => MediaIslandContent().buildContent(size, budget),
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 3,
}

export default mediaWidget
