import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { makeCoverArt, PANEL_ART, PANEL_ART_RADIUS } from "../common/CoverArt"
import { makeHSlider } from "../../lib/nidara-kit"
import { AtomicWidget, WidgetSize } from "../common/widget-kit"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import * as media from "../core/MediaService"
import Theme from "../core/ThemeManager"
import { attachTooltip } from "../common/Tooltip"
import { menuRow, menuSeparator } from "../common/MenuRow"
import GlassBubbleMenu from "../common/GlassBubbleMenu"

// NO bar variant. The Activity Island already carries the player as an activity
// (IslandActivities' mediaActivity: cover art in the compact capsule the moment
// an MPRIS player is live, the full panel when it opens), so a bar pill with its
// own transport buttons was the same service stated twice, a capsule apart. The
// island is the single home; the CC tile is the grid's copy of it. See
// references/architecture.md.

// Hours-aware time formatter shared by the island panel and CC detail
function fmt(secs: number): string {
    const s = Math.max(0, Math.floor(secs))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`
}

// Shared rich player panel used by the CC detail page and the Activity Island's
// player mode (surfaces/island/PlayerIsland.tsx) — the bar expanded pill was the
// third caller until the bar variant went away (see above).
// Progress is expressed as 0-100% so makeHSlider's range never needs to change.
export function buildMediaDetailPanel(widthRequest: number): Gtk.Widget {
    let player: any = null
    let playerSigId: number | null = null
    let progressTimer: number | null = null
    let progressUpdateCb: ((pct: number) => void) | null = null

    const artDa = makeCoverArt({ size: PANEL_ART, shape: PANEL_ART_RADIUS })
    artDa.halign = Gtk.Align.START
    artDa.valign = Gtk.Align.CENTER

    // Wrap to up to 2 lines (uses the width to the right of the artwork) and only
    // ellipsize if the title still overflows two lines.
    const titleLabel = new Gtk.Label({
        label: t("cc.media.no-media"), css_classes: ["nidara-media-title"],
        halign: Gtk.Align.START, hexpand: true, xalign: 0,
        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: 3,
        max_width_chars: 30,
    })
    const artistLabel = new Gtk.Label({
        label: "", css_classes: ["nidara-media-artist"],
        halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 26,
    })

    const prevImg = new Gtk.Image({ gicon: Icons.skipBack,    pixel_size: 16, css_classes: ["nd-icon"] })
    const playImg = new Gtk.Image({ gicon: Icons.play,        pixel_size: 20, css_classes: ["nd-icon"] })
    const nextImg = new Gtk.Image({ gicon: Icons.skipForward, pixel_size: 16, css_classes: ["nd-icon"] })
    const prev = new Gtk.Button({ child: prevImg, css_classes: ["nidara-media-btn"], valign: Gtk.Align.CENTER })
    const play = new Gtk.Button({ child: playImg, css_classes: ["nidara-media-btn", "nidara-media-play-btn"], valign: Gtk.Align.CENTER })
    const next = new Gtk.Button({ child: nextImg, css_classes: ["nidara-media-btn"], valign: Gtk.Align.CENTER })
    prev.set_size_request(32, 32); play.set_size_request(36, 36); next.set_size_request(32, 32)

    const ctrlBox = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER, hexpand: true })
    ctrlBox.append(prev); ctrlBox.append(play); ctrlBox.append(next)

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.CENTER, hexpand: true })
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
        child: srcInner, css_classes: ["nidara-media-btn"],
        halign: Gtk.Align.END, valign: Gtk.Align.START, visible: false,
    })
    attachTooltip(sourceBtn, () => t("cc.media.source"))

    let bubbleMenu: GlassBubbleMenu | null = null

    const ensureSourceMenu = () => {
        if (bubbleMenu) return
        bubbleMenu = new GlassBubbleMenu({
            parent: sourceBtn,
            position: Gtk.PositionType.BOTTOM,
            side: "top",
        })
    }

    const rebuildSourceRows = () => {
        if (!bubbleMenu) return
        bubbleMenu.clearRows()
        bubbleMenu.rows.append(menuRow({
            label: t("cc.media.source.auto"),
            checked: media.pinnedBus() === null,
            onClick: () => { media.pinPlayer(null); bubbleMenu?.popdown() },
        }))
        const list = media.players()
        if (list.length > 0) bubbleMenu.rows.append(menuSeparator())
        for (const pl of list) {
            // Dim current-title hint so two windows of the same app stay tellable apart
            const hint = new Gtk.Label({
                label: pl.title || "", css_classes: ["nidara-menu-label"],
                opacity: 0.55, ellipsize: 3, max_width_chars: 14, visible: !!pl.title,
            })
            const rowIcon = media.playerAppIcon(pl)
            bubbleMenu.rows.append(menuRow({
                label: media.playerLabel(pl),
                icon: rowIcon ?? Icons.play,
                appIcon: !!rowIcon,
                checked: media.pinnedBus() === pl.bus_name,
                trailing: hint,
                onClick: () => { media.pinPlayer(pl.bus_name); bubbleMenu?.popdown() },
            }))
        }
    }

    sourceBtn.connect("clicked", () => {
        if (bubbleMenu?.popover.visible) { bubbleMenu.popdown(); return }
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
        bubbleMenu!.setPosition(pos)
        rebuildSourceRows()
        bubbleMenu!.popup()
    })

    const topRow = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    topRow.append(artDa)
    topRow.append(textBox)
    topRow.append(sourceBtn)

    const elapsedLabel = new Gtk.Label({ label: "0:00", css_classes: ["nidara-media-time"], halign: Gtk.Align.START })
    const totalLabel   = new Gtk.Label({ label: "--:--", css_classes: ["nidara-media-time"], halign: Gtk.Align.END, hexpand: true })
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
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
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

    // The app icon only changes with the PLAYER, not per notify — resolving a
    // fresh GIcon each tick would defeat the identity guard (tech-debt #11C).
    let srcIconBus: string | null = null
    const update = () => {
        const p = player
        titleLabel.label  = p?.title  || t("cc.media.no-media")
        artistLabel.label = p?.artist || ""
        // gicon assignment is NOT equality-guarded by GTK — same-icon reassign forces a redraw
        const wantPlay = p?.playback_status === media.PlaybackStatus.PLAYING ? Icons.pause : Icons.play
        if (playImg.gicon !== wantPlay) playImg.gicon = wantPlay
        prev.sensitive = p?.can_go_previous !== false
        next.sensitive = p?.can_go_next    !== false
        sourceBtn.visible = !!p
        const bus = p?.bus_name ?? null
        if (bus !== srcIconBus) {
            srcIconBus = bus
            const appIcon = media.playerAppIcon(p)
            srcAppImg.gicon = appIcon ?? Icons.play
            // App icons are full-color — nd-icon's invert(1) (for the shell's
            // black symbolic SVGs) turns them negative. Keep it only for the
            // play fallback.
            if (appIcon) srcAppImg.remove_css_class("nd-icon")
            else srcAppImg.add_css_class("nd-icon")
        }
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
        if (bubbleMenu) {
            bubbleMenu.destroy()
            try { bubbleMenu.popover.unparent() } catch {}
            bubbleMenu = null
        }
    })

    updatePlayer()
    // Landing slot of the island morph's cover-art pair (PlayerIsland.tsx).
    ;(root as any).artDa = artDa
    return root
}

function buildCCDetail(_onClose: () => void): Gtk.Widget {
    return buildMediaDetailPanel(0)
}

// ── CC tile content ───────────────────────────────────────────────────────────

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

// Tier dispatch. The spec factory this replaced also declared a `defaultSize` and a
// `supportedSizes` that NOTHING read — the registry entry below is the one that
// counts, and having both is how a CCWidgetSpec's metadata came to be a second,
// silent copy of a widget's own.
function buildCCContent(size: WidgetSize): Gtk.Widget {
    const state = (sharedState ??= makeMediaState())
    return size === WidgetSize.WIDE   ? buildWideContent(state)
         : size === WidgetSize.SINGLE ? buildSingleContent()
         :                              buildSquareContent(state)
}


const mediaWidget: AtomicWidget = {
    id: "media",
    category: "media",
    name: t("cc.media.name"),
    icon: Icons.play,
    locations: ["cc"],
    defaultSize: WidgetSize.SQUARE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, _budget) => buildCCContent(size),
    buildCCDetail,
    ccDetailRows: 3,
}

export default mediaWidget
