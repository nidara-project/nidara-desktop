import Gtk from "gi://Gtk?version=4.0"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, AtomicWidget, ContentBudget, PANEL_W, WidgetSize, makeIconTile, makeCapsuleInner, wrapCapsuleTile } from "../common/widget-kit"
import { NidaraButton } from "../../lib/nidara-kit/button"
import GLib from "gi://GLib"
import { execAsync } from "../../lib/process"

import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import status, { recordingElapsed } from "../core/Status"
import { buildCaptureCommand } from "../core/RecordingConfig"

// ── Types ─────────────────────────────────────────────────────────────────────

type RecordMode = "screen" | "region"

// ── Capture ───────────────────────────────────────────────────────────────────

async function startRecording(mode: RecordMode, withAudio: boolean, onClose: () => void) {
    // Close overlay first so it doesn't appear in region selector
    onClose()
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        resolve(null)
        return GLib.SOURCE_REMOVE
    }))

    let region: string | undefined
    if (mode === "region") {
        try {
            region = (await execAsync(["slurp"])).trim()
        } catch {
            return // user cancelled slurp
        }
    }

    // Quality, container, frame rate, destination and WHICH audio source all
    // come from the widget's settings (core/RecordingConfig) — the panel only
    // decides screen-or-region and audio-or-not.
    const { argv, outFile, audioDevice } = await buildCaptureCommand({ region, audio: withAudio })

    status.recording = true
    stopsAsked = 0
    try {
        await execAsync(argv)
    } catch {
        // wf-recorder exits with non-zero on SIGINT — that's normal
    } finally {
        status.recording = false
        const forced = stopsAsked > 1
        stopsAsked = 0
        // A recorder ended by force, or one that never got a frame, wrote no usable
        // file: "saved" would point at nothing.
        if (forced || !GLib.file_test(outFile, GLib.FileTest.EXISTS)) {
            execAsync(["notify-send", t("widget.screenrecord.failed")]).catch(() => {})
            return
        }
        // Say so when audio was asked for and no source could be resolved:
        // wf-recorder would otherwise write a perfectly normal-looking file that
        // is simply silent, which is exactly the failure this feature had.
        const body = withAudio && !audioDevice
            ? `${outFile}\n${t("widget.screenrecord.no-audio")}`
            : outFile
        execAsync(["notify-send", t("widget.screenrecord.saved"), body]).catch(() => {})
    }
}

// Stop asks wf-recorder to finish (SIGINT: it writes the file's end and exits). A recorder
// that does not answer — waiting for a frame that never comes, as every GPU recording did on
// Hyalo before its screencopy offered a dmabuf (2026-10-03) — is ended by the SECOND Stop:
// the button must always stop.
let stopsAsked = 0

export async function stopRecording() {
    stopsAsked++
    const signal = stopsAsked > 1 ? "-SIGKILL" : "-SIGINT"
    await execAsync(["pkill", signal, "wf-recorder"]).catch(() => {})
}

// ── Recording elapsed timer ────────────────────────────────────────────────────
// The text comes from core (recordingElapsed → status.recordingStartedAt): the
// SHARED stamp, never a local one, so a surface built mid-capture shows the true
// elapsed time instead of restarting (or freezing) at 0:00.

// Drive `apply` once now, on every recording state change, and once a second
// while recording. `full` is true for the two former (the state may have
// flipped: re-read everything) and false for a mere tick (only the clock moved).
// Returns the teardown for the caller's unrealize.
function driveElapsed(apply: (full: boolean) => void): () => void {
    let timerId = 0
    const stopTick = () => { if (timerId) { GLib.source_remove(timerId); timerId = 0 } }
    const sync = () => {
        apply(true)
        stopTick()
        // Ticks ONLY while recording — an idle timer would repaint a blurred
        // surface once a second for nothing.
        if (status.recording) timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            apply(false)
            return GLib.SOURCE_CONTINUE
        })
    }
    const sigId = status.connect("notify::recording", sync)
    sync()   // initial sync: the signal may have fired long before this was built
    return () => { safeDisconnect(status, sigId); stopTick() }
}

function makeElapsedLabel(): Gtk.Label {
    const label = new Gtk.Label({ label: recordingElapsed(), css_classes: ["rec-elapsed-big"] })
    const dispose = driveElapsed(() => { label.label = recordingElapsed() })
    label.connect("unrealize", dispose)
    return label
}

// ── Record controls (shared by bar expansion + CC popover) ───────────────────

function buildRecordPopoverContent(onClose: () => void): Gtk.Widget {
    let selectedMode: RecordMode = "screen"

    const modeRow = new Gtk.Box({ spacing: 4, homogeneous: true })
    const screenBtn = new Gtk.Button({ label: t("widget.screenrecord.mode.screen"), css_classes: ["nidara-seg-btn", "suggested-action"] })
    const regionBtn = new Gtk.Button({ label: t("widget.screenrecord.mode.region"), css_classes: ["nidara-seg-btn"] })
    screenBtn.connect("clicked", () => {
        selectedMode = "screen"
        screenBtn.add_css_class("suggested-action")
        regionBtn.remove_css_class("suggested-action")
    })
    regionBtn.connect("clicked", () => {
        selectedMode = "region"
        regionBtn.add_css_class("suggested-action")
        screenBtn.remove_css_class("suggested-action")
    })
    modeRow.append(screenBtn)
    modeRow.append(regionBtn)

    const audioRow = new Gtk.Box({ spacing: 8 })
    const audioSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER })
    audioSwitch.update_property([Gtk.AccessibleProperty.LABEL], [t("widget.screenrecord.audio")])   // #615
    // nidara-row-title gives it the mode-aware text colour (a plain Gtk.Label
    // inherits an unreliable default that rendered white in light mode too).
    const audioLabel = new Gtk.Label({ label: t("widget.screenrecord.audio"), hexpand: true, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] })
    audioRow.append(audioLabel)
    audioRow.append(audioSwitch)

    // NidaraButton (unscoped `button.nidara-btn`) rather than Adwaita's
    // `suggested-action`, which only looks right inside the two panel scopes that
    // happen to restyle it — see nidara-kit/button.ts. The segmented mode row
    // above keeps `suggested-action` on purpose: there it is not a button style
    // but the SELECTED marker of `.nidara-seg-btn`, which owns its own rule.
    const startBtn = NidaraButton({ label: t("widget.screenrecord.start"), variant: "primary" })
    startBtn.hexpand = true
    // Read the switch AT CLICK TIME rather than mirroring it into a closure via
    // notify::active. The mirror is one more thing that has to fire for audio to
    // survive the trip to wf-recorder, and it is not observable from the file
    // that comes out — the switch itself is the state, so ask it.
    startBtn.connect("clicked", () => startRecording(selectedMode, audioSwitch.active, onClose))

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, width_request: PANEL_W.sm })
    box.append(modeRow)
    box.append(new Gtk.Separator())
    box.append(audioRow)
    box.append(new Gtk.Separator())
    box.append(startBtn)
    return box
}

// ── CC widget content ─────────────────────────────────────────────────────────

function buildContent(size: WidgetSize, budget: ContentBudget): Gtk.Widget {
    if (size === WidgetSize.SINGLE)
        return makeIconTile(
            () => status.recording ? uiIcon("nd-media-playback-stop") : uiIcon("nd-media-record"),
            (sync) => {
                const sigId = status.connect("notify::recording", sync)
                return () => safeDisconnect(status, sigId)
            })

    // WIDE: a single capsule whose state (idle ⇄ recording) is driven by
    // status.recording — the SAME dynamic-capsule path as every other tile
    // (makeCapsuleInner + update via getters). The old idle/recording Gtk.Stack
    // inset this tile's content a few px off from the rest of the column; routing it
    // through makeCapsuleInner + wrapCapsuleTile (like screenshot/clipboard) lands
    // the icon/text on the exact same grid. Idle = action tile (name, no sub);
    // recording = "Recording…" + a live elapsed timer in the subtitle slot. The
    // on-state itself is BaseIsland's getActive (see the widget registration
    // below) — this content only owns icon/text, not any
    // background tint anymore (the old .rec-active-bg icon-badge tint and
    // .rec-stop-icon/.rec-label colour overrides are gone: the WHOLE capsule fills
    // now, and .rec-stop-icon was dead CSS anyway — colour never applies to a
    // Gtk.Image, only -gtk-icon-filter does, see design-system.md).
    const getIcon  = () => status.recording ? uiIcon("nd-media-playback-stop") : uiIcon("nd-media-record")
    const getTitle = () => status.recording ? t("widget.screenrecord.recording") : t("widget.screenrecord.name")
    const getSub   = () => status.recording ? recordingElapsed() : ""

    const inner = makeCapsuleInner(getIcon, getTitle, getSub, budget)

    // One driver for both jobs: a `full` pass re-reads icon/title/sub (the state
    // flipped), a tick only moves the subtitle's digits.
    const dispose = driveElapsed((full) => {
        if (!full) { inner.subLabel.label = getSub(); return }
        inner.update()                               // re-reads icon/title/sub
        if (status.recording) inner.subLabel.add_css_class("rec-elapsed")
        else inner.subLabel.remove_css_class("rec-elapsed")
    })
    inner.box.connect("unrealize", dispose)

    return wrapCapsuleTile(inner.box)
}

// ── Bar icon (dynamic recording state indicator) ──────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: uiIcon("nd-media-record"), pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
    // The GLYPH is the whole signal: record ⇄ stop, matching what the click now
    // does. No colour class — `.rec-bar-active` had no rule anywhere and could
    // never have had one: `color:` does not recolour a Gtk.Image unless the icon
    // filename ends in -symbolic (design-system.md), exactly like the
    // `.rec-stop-icon` that was deleted for the same reason. The red belongs to
    // the island dot two capsules away, which is where the state is stated.
    const syncState = () => {
        image.gicon = status.recording ? uiIcon("nd-media-playback-stop") : uiIcon("nd-media-record")
    }
    const sigId = status.connect("notify::recording", syncState)
    image.connect("unrealize", () => { safeDisconnect(status, sigId) })
    syncState()
    return image
}

// ── Bar expansion panel content ───────────────────────────────────────────────
// SETUP ONLY. While a capture is live the bar pill never opens this panel — a
// click on it stops the recording outright (see barClick below), so the panel
// has no "recording" page to switch to and no Gtk.Stack sizing everything to
// its largest child. The elapsed time lives in the Activity Island, which is
// always on screen; repeating it in a panel you have to open first was the
// duplicate, not the service.
function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildRecordPopoverContent(onClose)
}

// ── CC detail page ────────────────────────────────────────────────────────────
// The Control Center's recording surface: setup while idle, elapsed + Stop while
// recording. Unlike the bar pill, a CC tile tap must not be destructive (it is
// the same tap that merely opens a detail everywhere else), so Stop is a real
// button here.
function buildCCDetail(onClose: () => void): Gtk.Widget {
    // vhomogeneous:false — a Gtk.Stack is homogeneous BY DEFAULT and would size
    // both pages to the taller one (setup), leaving the two-control recording
    // page floating in a panel built for a mode row + a switch + a button.
    // interpolate_size animates the shrink instead of snapping it.
    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 150,
        vhomogeneous: false, interpolate_size: true, valign: Gtk.Align.START,
    })

    // ── Idle page ──────────────────────────────────────────────
    stack.add_named(buildRecordPopoverContent(onClose), "idle")

    // ── Recording page ─────────────────────────────────────────
    // `primary`, NOT `danger`: red on a button promises the click destroys
    // something, and stopping a capture you started on purpose is how the flow
    // finishes — it writes the file. Same role Start has on the other page, so
    // the same button. Danger is left for deletion.
    const stopBtn = NidaraButton({ label: t("widget.screenrecord.stop"), variant: "primary" })
    stopBtn.hexpand = true
    stopBtn.connect("clicked", () => stopRecording())
    const recBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, width_request: PANEL_W.sm })
    recBox.append(makeElapsedLabel())
    recBox.append(stopBtn)
    stack.add_named(recBox, "recording")

    // Keep stack in sync with recording state
    const syncStack = () => stack.set_visible_child_name(status.recording ? "recording" : "idle")
    const sigId = status.connect("notify::recording", syncStack)
    stack.connect("unrealize", () => { safeDisconnect(status, sigId) })
    syncStack()

    return stack
}

// ── Widget registration ───────────────────────────────────────────────────────

const screenrecordWidget: AtomicWidget = {
    id: "screenrecord",
    category: "utilities",
    barOrder: 60,
    name: t("widget.screenrecord.name"),
    icon: uiIcon("nd-media-record"),
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 2,
    // The bar pill is a STOP BUTTON while recording: one click ends the capture,
    // no panel, no confirmation. Stopping is the only thing you want from that
    // icon once a capture is live, and making you open a panel to reach a button
    // was two clicks for a one-click intent. Idle → returns false → the normal
    // expansion panel (setup) opens.
    barClick: () => {
        if (!status.recording) return false
        void stopRecording()
        return true
    },
    // Recording shows the tile ON, exactly like every other tile that is switched
    // on (dark_mode, night_light, focus…: white, the icon in the accent) — no `activeColorHex`,
    // no pulse. It used to be a throbbing DANGER_HEX, which was two mistakes at
    // once (2026-08-02): the throb meant a ~15 fps Cairo redraw of a tile on a
    // blurred surface for the whole capture, and the red said "alarm" about a
    // tile that is simply a control in its on state. The place red still earns is
    // the STATUS mark — the island dot, the CC badge — where it is 8px and means
    // "this is happening whether or not you are looking". A tile is not that.
    getActive: () => status.recording,
    watchActive: (cb) => {
        const sigId = status.connect("notify::recording", cb)
        return () => safeDisconnect(status, sigId)
    },
    // NO `barActive`: the bar item is where a capture STARTS (and, while one runs,
    // its one-click Stop), so a "when active" mode would hide the only way to begin
    // one from the bar. It shipped that way in #651 as the default, and Settings
    // offers Configure instead of the mode menu for this row — so the icon never
    // showed and nothing could bring it back (owner, 2026-09-27). Checked = shown.
    // Out of the box it is in the CC, beside Screenshot, not in the bar (owner, 2026-09-28).
    defaultInBar: false,
}

export default screenrecordWidget
