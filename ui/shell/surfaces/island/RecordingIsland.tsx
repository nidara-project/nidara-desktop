import { Gtk } from "ags/gtk4"
import SquircleContainer from "../../common/SquircleContainer"
import { RADIUS } from "../../../lib/tokens"
import { NidaraButton } from "../../../lib/nidara-kit/button"
import { PANEL_W } from "../../common/widget-kit"
import { t } from "../../core/i18n"
import { safeDisconnect } from "../../core/signals"
import GLib from "gi://GLib"
import status, { recordingElapsed } from "../../core/Status"
// A surface importing a widget is unusual — verified cycle-free: screenrecord's
// own imports are core/ + control-center/Types + Toggles + widget-kit, and none
// of those reaches surfaces/island (the boot-crashing cycle to avoid is the one
// through CCLayoutManager → widgets/index, see architecture.md).
import { stopRecording } from "../../widgets/screenrecord"

// The live-capture expanded surface: the elapsed clock, big, and Stop.
//
// WHY IT EXISTS (2026-08-02). The recording activity used to have no mode of its
// own and sent its click to the Control Center instead, back when the CC banner
// held the only Stop button. Both halves of that have since stopped being true:
// the banner row is gone (the island owns the live capture — see
// bar/StatusIndicators.tsx), and the screenrecord widget can be placed in the
// BAR ONLY, so opening the CC could land the user on a panel with nothing about
// the recording in it at all. A capture is the island's own business now, so the
// island answers for it — which also means stopping never depends on where the
// user chose to put a widget.
//
// Deliberately a statement + one action, like BatteryIsland: there is nothing
// else to decide once a capture is running. NO danger red anywhere but the dot
// (see the SCSS note): red marks the destructive edge of an action, and stopping
// a recording you started on purpose is how the flow FINISHES — it saves the
// file, it doesn't destroy anything.
//
// Glass recipe exported for ActivityIsland's MorphRevealer, same contract as
// PLAYER_GLASS / BATTERY_GLASS.
export const RECORDING_GLASS = { radius: RADIUS.xl, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

export default function RecordingIsland(): Gtk.Widget {
    const head = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER })
    head.append(new Gtk.Box({
        css_classes: ["island-rec-dot"],
        width_request: 8, height_request: 8, valign: Gtk.Align.CENTER,
    }))
    head.append(new Gtk.Label({ label: t("island.recording.title"), css_classes: ["island-battery-title"] }))

    const clock = new Gtk.Label({
        label: recordingElapsed(),
        css_classes: ["island-rec-clock"],
        halign: Gtk.Align.CENTER,
    })

    // Ticks only while the capture runs AND this card is mapped: the mode is
    // built once and lives hidden for the rest of the session, and a hidden
    // surface repainting once a second is a blur pass the compositor pays for
    // nothing (the same rule as common/poll.ts).
    let tick = 0
    const stopTick = () => { if (tick) { GLib.source_remove(tick); tick = 0 } }
    const sync = () => {
        clock.label = recordingElapsed()
        stopTick()
        if (status.recording && clock.get_mapped()) tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            clock.label = recordingElapsed()
            return GLib.SOURCE_CONTINUE
        })
    }
    const sigId = status.connect("notify::recording", sync)
    clock.connect("map", sync)
    clock.connect("unmap", stopTick)
    clock.connect("unrealize", () => { safeDisconnect(status, sigId); stopTick() })

    // NidaraButton, not `suggested-action`: the Adwaita class is only restyled
    // inside `.bar-expansion-panel` / `.cc-detail-panel`, and the island is
    // neither — it rendered as raw GTK blue, an accent the user never picked.
    // `button.nidara-btn` is unscoped, so it is the only button vocabulary that
    // looks right in EVERY window (nidara-kit/button.ts).
    const stopBtn = NidaraButton({ label: t("widget.screenrecord.stop"), variant: "primary" })
    stopBtn.hexpand = true
    // The engine closes this mode by itself when the activity dies (status
    // .recording goes false → not live → its open surface is dropped), so the
    // button only has to stop the capture.
    stopBtn.connect("clicked", () => { void stopRecording() })

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        margin_top: 16, margin_bottom: 16, margin_start: 20, margin_end: 20,
        width_request: PANEL_W.sm,
    })
    inner.append(head)
    inner.append(clock)
    inner.append(stopBtn)

    const squircle = SquircleContainer({
        child: inner,
        n: RECORDING_GLASS.n,
        radius: RECORDING_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: RECORDING_GLASS.border,
    })
    const windowContent = new Gtk.Box({
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
    })
    windowContent.append(squircle)

    // Morph handles (see common/MorphRevealer.ts). No morphArt: the compact's
    // dot+clock has no element that FLIES here — its continuity is the
    // dissolving source twin (recActivity's makeGhost).
    ;(windowContent as any).morphContent = inner
    ;(windowContent as any).morphGlass = squircle
    return windowContent
}
