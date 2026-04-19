import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalWp from "gi://AstalWp"
import { VolumeWidget } from "../control-center/Sliders"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"

function buildBarContent(): Gtk.Widget {
    const speaker = AstalWp.get_default()?.audio?.default_speaker

    const getIcon = () => {
        if (!speaker) return "audio-volume-muted-symbolic"
        const muted = (speaker as any).mute ?? false
        const vol = speaker.volume
        if (muted || vol === 0) return "audio-volume-muted-symbolic"
        if (vol < 0.34)         return "audio-volume-low-symbolic"
        if (vol < 0.67)         return "audio-volume-medium-symbolic"
        return "audio-volume-high-symbolic"
    }

    const image = new Gtk.Image({ icon_name: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16 })

    // Keep icon in sync
    if (speaker) {
        const ids = [
            speaker.connect("notify::volume", () => { image.icon_name = getIcon() }),
            (speaker as any).connect?.("notify::mute", () => { image.icon_name = getIcon() }) ?? 0,
        ]
        image.connect("unrealize", () => ids.forEach(id => { if (id) try { speaker.disconnect(id) } catch {} }))
    }

    // ── Popover content ──────────────────────────────────────────
    const volLabel = new Gtk.Label({
        label: speaker ? `${Math.round(speaker.volume * 100)}%` : "–",
        css_classes: ["bar-popover-value"],
        halign: Gtk.Align.CENTER,
        width_chars: 5, xalign: 1.0,
    })

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        draw_value: false,
        hexpand: true,
        width_request: 200,
        css_classes: ["crystal-scale"],
    })
    scale.set_range(0, 100)
    scale.set_value(speaker ? Math.round(speaker.volume * 100) : 50)
    scale.set_increments(1, 5)
    scale.connect("change-value", (_s: Gtk.Scale, t: Gtk.ScrollType) =>
        t === Gtk.ScrollType.JUMP || t === Gtk.ScrollType.PAGE_FORWARD || t === Gtk.ScrollType.PAGE_BACKWARD)

    const click = new Gtk.GestureClick({ propagation_phase: Gtk.PropagationPhase.CAPTURE, button: 1 })
    const motion = new Gtk.EventControllerMotion({ propagation_phase: Gtk.PropagationPhase.CAPTURE })
    scale.add_controller(click)
    scale.add_controller(motion)
    let isDragging = false, dragStart = 0, startX = 0, trackW = 1
    let pendingMotion = false, lastMotionX = 0
    click.connect("pressed", (_g: Gtk.GestureClick, _n: number, x: number) => {
        _g.set_state(Gtk.EventSequenceState.CLAIMED)
        isDragging = true
        dragStart = scale.get_value()
        startX = x
        trackW = Math.max(20, scale.get_width() - 20)
    })
    click.connect("released", () => { isDragging = false })
    motion.connect("motion", (_g: Gtk.EventControllerMotion, x: number) => {
        if (!isDragging) return
        lastMotionX = x
        if (!pendingMotion) {
            pendingMotion = true
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (isDragging) scale.set_value(Math.max(0, Math.min(100, dragStart + ((lastMotionX - startX) / trackW) * 100)))
                pendingMotion = false
                return GLib.SOURCE_REMOVE
            })
        }
    })

    let ignoreUntil = 0
    let pendingOnChange = false
    scale.connect("value-changed", () => {
        const v = scale.get_value()
        volLabel.label = `${Math.round(v)}%`
        ignoreUntil = GLib.get_monotonic_time() + 300_000
        if (!pendingOnChange) {
            pendingOnChange = true
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (speaker) speaker.volume = scale.get_value() / 100
                pendingOnChange = false
                return GLib.SOURCE_REMOVE
            })
        }
    })

    if (speaker) {
        const id = speaker.connect("notify::volume", () => {
            if (GLib.get_monotonic_time() < ignoreUntil) return
            const v = Math.round(speaker.volume * 100)
            if (Math.abs(scale.get_value() - v) > 1) {
                scale.set_value(v)
                volLabel.label = `${v}%`
            }
        })
        scale.connect("unrealize", () => { try { speaker.disconnect(id) } catch {} })
    }

    const muteBtn = new Gtk.Button({
        icon_name: (speaker as any)?.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic",
        css_classes: ["bar-popover-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    muteBtn.connect("clicked", () => {
        if (speaker) (speaker as any).mute = !((speaker as any).mute ?? false)
        muteBtn.icon_name = (speaker as any)?.mute ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic"
    })

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(muteBtn)
    row.append(scale)
    row.append(volLabel)

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 14,
        margin_end: 14,
    })
    popBox.append(new Gtk.Label({ label: t("cc.volume.name"), css_classes: ["bar-popover-title"], halign: Gtk.Align.START }))
    popBox.append(row)

    const popover = new Gtk.Popover({ autohide: true, position: Gtk.PositionType.BOTTOM })
    popover.set_child(popBox)
    popover.set_parent(image)
    image.connect("unrealize", () => { try { popover.unparent() } catch {} })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

const volumeWidget: AtomicWidget = {
    id: "volume",
    name: t("cc.volume.name"),
    icon: "audio-volume-high-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.FULL_WIDTH, WidgetSize.TALL],
    buildContent: (size) => VolumeWidget().buildContent(size),
    buildBarContent,
}

export default volumeWidget
