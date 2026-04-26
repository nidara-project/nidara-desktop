import { Gtk } from "ags/gtk4"
import AstalMpris from "gi://AstalMpris"
import { MediaIslandContent } from "../control-center/MediaIsland"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

function buildBarContent(): Gtk.Widget {
    const mpris = AstalMpris.get_default()

    const prev = new Gtk.Button({ icon_name: Icons.skipBack,    css_classes: ["bar-media-btn"] })
    const play = new Gtk.Button({ icon_name: Icons.play,        css_classes: ["bar-media-btn"] })
    const next = new Gtk.Button({ icon_name: Icons.skipForward, css_classes: ["bar-media-btn"] })

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
        margin_start: 10,
        margin_end: 10,
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
        play.icon_name = playing ? Icons.pause : Icons.play
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

const mediaWidget: AtomicWidget = {
    id: "media",
    name: t("cc.media.name"),
    icon: Icons.play,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SQUARE,
    supportedSizes: [WidgetSize.SQUARE, WidgetSize.WIDE],
    buildContent: (size) => MediaIslandContent().buildContent(size),
    buildBarContent,
}

export default mediaWidget
