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
import { safeDisconnect } from "../core/signals"
import * as media from "../core/MediaService"
import Theme from "../core/ThemeManager"
import { attachTooltip } from "../common/Tooltip"
import { menuRow, menuSeparator } from "../common/MenuRow"
import { sideFor, paintGlassBubble, ARROW_H, BUF, type ArrowSide } from "../common/GlassBubble"

function buildBarContent(): Gtk.Widget {
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
        safeDisconnect(player, playerSigId)
        playerSigId = null
        player = media.selectedPlayer()
        if (player) playerSigId = player.connect("notify", update)
        update()
    }

    const unsubscribe = media.subscribe(updatePlayer)
    box.connect("unrealize", () => {
        unsubscribe()
        safeDisconnect(player, playerSigId)
    })

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

    // SOURCE SELECTOR — the current player's app icon + a chevron, top-right of
    // the panel. Opens a glass menu (same Gtk.Popover + GlassBubble + menuRow
    // pattern as the dock/app-grid context menus) listing every MPRIS player:
    // "Automatic" follows MediaService's heuristic; picking an app pins it.
    const srcAppImg  = new Gtk.Image({ gicon: Icons.play, pixel_size: 16, css_classes: ["nd-icon"] })
    const srcChevron = new Gtk.Image({ gicon: Icons.chevronDown, pixel_size: 10, css_classes: ["nd-icon"], opacity: 0.6 })
    const srcInner = new Gtk.Box({ spacing: 2 })
    srcInner.append(srcAppImg); srcInner.append(srcChevron)
    const sourceBtn = new Gtk.Button({
        child: srcInner, css_classes: ["cc-media-btn-atomic"],
        halign: Gtk.Align.END, valign: Gtk.Align.START, visible: false,
    })
    attachTooltip(sourceBtn, () => t("cc.media.source"))

    let srcPopover: Gtk.Popover | null = null
    let srcRows: Gtk.Box | null = null
    let srcDraw: Gtk.DrawingArea | null = null
    let srcSide: ArrowSide = "top"
    let srcThemeId = 0

    const ensureSourceMenu = () => {
        if (srcPopover) return
        srcPopover = new Gtk.Popover({
            autohide: true,        // grabs focus; dismiss on outside click
            has_arrow: false,      // we paint our own pointer in Cairo
            css_classes: ["nidara-menu-popover"],
        })
        srcPopover.set_has_tooltip(false)
        const grid = new Gtk.Grid()
        srcDraw = new Gtk.DrawingArea({ hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })
        srcDraw.set_draw_func((_da, cr, w, h) => paintGlassBubble(cr, w, h, srcSide, { radiusMax: 16 }))
        grid.attach(srcDraw, 0, 0, 1, 1)
        srcRows = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["nidara-menu"] })
        grid.attach(srcRows, 0, 0, 1, 1)
        srcThemeId = Theme.connect("changed", () => { if (srcDraw?.get_mapped()) srcDraw.queue_draw() })
        srcPopover.set_child(grid)
        srcPopover.set_parent(sourceBtn)
    }

    const layoutSourceMenu = () => {
        if (!srcRows) return
        const PAD = 5   // interior padding between the glass edge and the rows
        srcRows.margin_top    = BUF + PAD + (srcSide === "top"    ? ARROW_H : 0)
        srcRows.margin_bottom = BUF + PAD + (srcSide === "bottom" ? ARROW_H : 0)
        srcRows.margin_start  = BUF + PAD + (srcSide === "left"   ? ARROW_H : 0)
        srcRows.margin_end    = BUF + PAD + (srcSide === "right"  ? ARROW_H : 0)
    }

    const rebuildSourceRows = () => {
        if (!srcRows) return
        let c = srcRows.get_first_child()
        while (c) { const next = c.get_next_sibling(); srcRows.remove(c); c = next }
        srcRows.append(menuRow({
            label: t("cc.media.source.auto"),
            checked: media.pinnedBus() === null,
            onClick: () => { media.pinPlayer(null); srcPopover?.popdown() },
        }))
        const list = media.players()
        if (list.length > 0) srcRows.append(menuSeparator())
        for (const pl of list) {
            // Dim current-title hint so two windows of the same app stay tellable apart
            const hint = new Gtk.Label({
                label: pl.title || "", css_classes: ["nidara-menu-label"],
                opacity: 0.55, ellipsize: 3, max_width_chars: 14, visible: !!pl.title,
            })
            srcRows.append(menuRow({
                label: media.playerLabel(pl),
                icon: media.playerAppIcon(pl) ?? Icons.play,
                checked: media.pinnedBus() === pl.bus_name,
                trailing: hint,
                onClick: () => { media.pinPlayer(pl.bus_name); srcPopover?.popdown() },
            }))
        }
    }

    sourceBtn.connect("clicked", () => {
        if (srcPopover?.visible) { srcPopover.popdown(); return }
        ensureSourceMenu()
        // Open downward by default; flip up when the button sits low on screen so
        // the menu stays visible and the fixed Cairo arrow still points at it.
        let pos = Gtk.PositionType.BOTTOM
        const rootW = sourceBtn.get_root() as Gtk.Widget | null
        if (rootW) {
            const [ok, bounds] = (sourceBtn as any).compute_bounds(rootW)
            if (ok && bounds && rootW.get_height() > 0
                && (bounds.origin.y + bounds.size.height / 2) > rootW.get_height() * 0.65) {
                pos = Gtk.PositionType.TOP
            }
        }
        srcSide = sideFor(pos)
        ;(srcPopover as any).position = pos
        layoutSourceMenu()
        rebuildSourceRows()
        srcPopover!.popup()
    })

    const topRow = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    topRow.append(artDa)
    topRow.append(textBox)
    topRow.append(sourceBtn)

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

    // Decode + redraw only when the art PATH changes — player "notify" fires at
    // 1 Hz while playing (position poll), so an unguarded decode here re-read the
    // PNG every second for the whole session (tech-debt #11C).
    let loadedArt: string | null = null
    const loadArt = () => {
        const path = media.resolveCoverArt(player)
        if (path === loadedArt) return
        loadedArt = path
        if (path) {
            try { artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, ART_SIZE, ART_SIZE, false) }
            catch { artPixbuf = null }
        } else { artPixbuf = null }
        artDa.queue_draw()
    }

    // The app icon only changes with the PLAYER, not per notify — resolving a
    // fresh GIcon each tick would defeat the identity guard (tech-debt #11C).
    let srcIconBus: string | null = null
    const update = () => {
        const p = player
        titleLabel.label  = p?.title  || t("cc.media.no-media")
        artistLabel.label = p?.artist || ""
        // gicon assignment is NOT equality-guarded by GTK — same-icon reassign forces a redraw
        const wantPlay = p?.playback_status === AstalMpris.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
        if (playImg.gicon !== wantPlay) playImg.gicon = wantPlay
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next    !== false
        sourceBtn.visible = !!p
        const bus = p?.bus_name ?? null
        if (bus !== srcIconBus) {
            srcIconBus = bus
            srcAppImg.gicon = media.playerAppIcon(p) ?? Icons.play
        }
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
        safeDisconnect(player, playerSigId); playerSigId = null
        player = media.selectedPlayer()
        if (player) { playerSigId = player.connect("notify", update); startTimer() }
        update()
    }

    prev.connect("clicked", () => { try { player?.previous()   } catch {} })
    play.connect("clicked", () => { try { player?.play_pause() } catch {} })
    next.connect("clicked", () => { try { player?.next()       } catch {} })

    const unsubscribe = media.subscribe(updatePlayer)
    root.connect("unrealize", () => {
        unsubscribe()
        safeDisconnect(player, playerSigId)
        if (progressTimer !== null) { try { GLib.source_remove(progressTimer) } catch {} ; progressTimer = null }
        // The popover is parented to sourceBtn, not a child of root — release it
        // explicitly or GTK warns on dispose. Nulled so a re-realize would rebuild.
        safeDisconnect(Theme, srcThemeId); srcThemeId = 0
        if (srcPopover) { try { srcPopover.unparent() } catch {} ; srcPopover = null; srcRows = null; srcDraw = null }
    })

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
