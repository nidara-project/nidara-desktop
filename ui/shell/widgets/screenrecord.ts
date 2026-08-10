import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { PANEL_W } from "../common/widget-kit"
import { NidaraButton } from "../../lib/nidara-kit/button"
import { NidaraDropDown } from "../../lib/nidara-kit/scrolled"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"
import { pageBox, listGroup, createRow, toggleRow, dropdownRow } from "../surfaces/settings/SettingsHelpers"

import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import status, { recordingElapsed } from "../core/Status"
import recordingConfig, {
    AUDIO_MIC, AUDIO_SYSTEM, FORMATS, FRAMERATES, QUALITIES,
    buildCaptureCommand, hardwareAvailable, listAudioDevices,
    type RecordFormat, type RecordQuality,
} from "../core/RecordingConfig"

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
    try {
        await execAsync(argv)
    } catch {
        // wf-recorder exits with non-zero on SIGINT — that's normal
    } finally {
        status.recording = false
        // Say so when audio was asked for and no source could be resolved:
        // wf-recorder would otherwise write a perfectly normal-looking file that
        // is simply silent, which is exactly the failure this feature had.
        const body = withAudio && !audioDevice
            ? `${outFile}\n${t("widget.screenrecord.no-audio")}`
            : outFile
        execAsync(["notify-send", t("widget.screenrecord.saved"), body]).catch(() => {})
    }
}

export async function stopRecording() {
    await execAsync(["pkill", "-SIGINT", "wf-recorder"]).catch(() => {})
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

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        const icon = new Gtk.Image({ gicon: status.recording ? Icons.recordStop : Icons.record, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["nd-icon"] })
        box.append(icon)
        const syncSingle = () => { icon.gicon = status.recording ? Icons.recordStop : Icons.record }
        const sigId = status.connect("notify::recording", syncSingle)
        box.connect("unrealize", () => { safeDisconnect(status, sigId) })
        return box
    }

    // WIDE: a single capsule whose state (idle ⇄ recording) is driven by
    // status.recording — the SAME dynamic-capsule path as every other tile
    // (buildCapsuleInner + update via getters). The old idle/recording Gtk.Stack
    // inset this tile's content a few px off from the rest of the column; routing it
    // through buildCapsuleInner + wrapCapsuleTile (like screenshot/clipboard) lands
    // the icon/text on the exact same grid. Idle = action tile (name, no sub);
    // recording = "Recording…" + a live elapsed timer in the subtitle slot. The
    // accent fill itself is BaseIsland's getActive (see the widget registration
    // below) — this content only owns icon/text, not any
    // background tint anymore (the old .rec-active-bg icon-badge tint and
    // .rec-stop-icon/.rec-label colour overrides are gone: the WHOLE capsule fills
    // now, and .rec-stop-icon was dead CSS anyway — colour never applies to a
    // Gtk.Image, only -gtk-icon-filter does, see design-system.md).
    const getIcon  = () => status.recording ? Icons.recordStop : Icons.record
    const getTitle = () => status.recording ? t("widget.screenrecord.recording") : t("widget.screenrecord.name")
    const getSub   = () => status.recording ? recordingElapsed() : ""

    const inner = buildCapsuleInner(getIcon, getTitle, getSub)

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
    const image = new Gtk.Image({ gicon: Icons.record, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    // The GLYPH is the whole signal: record ⇄ stop, matching what the click now
    // does. No colour class — `.rec-bar-active` had no rule anywhere and could
    // never have had one: `color:` does not recolour a Gtk.Image unless the icon
    // filename ends in -symbolic (design-system.md), exactly like the
    // `.rec-stop-icon` that was deleted for the same reason. The red belongs to
    // the island dot two capsules away, which is where the state is stated.
    const syncState = () => {
        image.gicon = status.recording ? Icons.recordStop : Icons.record
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

// ── Settings subpage ──────────────────────────────────────────────────────────
// Reached from Settings → Widgets → Screen recording ›. This is the first user
// of AtomicWidget.buildSettings: the widget's preferences live WITH the widget
// (the "mini-app" contract in Types.ts), not in a Settings page that would have
// to know what a screen recorder needs.

/** The audio-source picker. Its options are the two logical sentinels plus every
 *  PulseAudio source, and that list only exists after pactl answers — so the row
 *  ships with the sentinels (which is what the default resolves to anyway) and
 *  splices the devices in when they arrive, without disturbing the selection. */
function audioSourceRow(): Gtk.ListBoxRow {
    const deviceLabels = new Map<string, string>()
    let values: string[] = [AUDIO_SYSTEM, AUDIO_MIC]
    const labels = () => values.map(v =>
        v === AUDIO_SYSTEM ? t("widget.screenrecord.settings.source.system")
        : v === AUDIO_MIC  ? t("widget.screenrecord.settings.source.mic")
        : deviceLabels.get(v) ?? v)

    const model = new Gtk.StringList({ strings: labels() })
    const drp = NidaraDropDown({ model, valign: Gtk.Align.CENTER })

    let syncing = false
    const selectStored = () => {
        const idx = values.indexOf(recordingConfig.audioSource)
        syncing = true
        drp.selected = idx >= 0 ? idx : 0
        syncing = false
    }
    selectStored()

    drp.connect("notify::selected", () => {
        if (syncing) return
        const v = values[drp.selected]
        if (v !== undefined) recordingConfig.setAudioSource(v)
    })

    listAudioDevices().then(devices => {
        for (const d of devices) deviceLabels.set(d.name, d.description)
        values = [AUDIO_SYSTEM, AUDIO_MIC, ...devices.map(d => d.name)]
        // splice(0, n, …) replaces the whole model in one go — swapping the
        // model object instead would reset `selected` to 0. Guarded, because the
        // replacement itself moves `selected` and the resulting notify would
        // otherwise persist whatever landed under the index mid-splice.
        syncing = true
        model.splice(0, model.get_n_items(), labels())
        syncing = false
        selectStored()
    }).catch(() => {})

    return createRow(
        t("widget.screenrecord.settings.source"),
        t("widget.screenrecord.settings.source.desc"),
        drp,
    )
}

/** Destination folder: the current path, and a button that opens a folder chooser. */
function saveDirRow(): Gtk.ListBoxRow {
    const home = GLib.get_home_dir()
    const pretty = (p: string) => p.startsWith(home) ? `~${p.slice(home.length)}` : p

    const pathLabel = new Gtk.Label({
        label: pretty(recordingConfig.saveDir),
        css_classes: ["dimmed"],
        ellipsize: 3, max_width_chars: 28, valign: Gtk.Align.CENTER,
    })
    const chooseBtn = NidaraButton({
        label: t("widget.screenrecord.settings.choose-folder"),
        variant: "secondary", pill: true, valign: Gtk.Align.CENTER,
    })
    chooseBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("widget.screenrecord.settings.dialog.folder"), modal: true })
        try { fd.set_initial_folder(Gio.File.new_for_path(recordingConfig.saveDir)) } catch {}
        fd.select_folder(chooseBtn.get_root() as Gtk.Window | null, null, (_: any, res: any) => {
            try {
                const path = fd.select_folder_finish(res)?.get_path()
                if (!path) return                 // cancelled
                recordingConfig.setSaveDir(path)
                pathLabel.label = pretty(path)
            } catch { /* cancelled */ }
        })
    })

    const trailing = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
    trailing.append(pathLabel)
    trailing.append(chooseBtn)
    return createRow(t("widget.screenrecord.settings.save-to"), "", trailing)
}

function buildSettings(): Gtk.Widget {
    const page = pageBox("screenrecord-settings-page")

    // ── Audio ─────────────────────────────────────────────────────────────
    const audio = listGroup(t("widget.screenrecord.settings.audio-group"))
    audio.listBox.append(audioSourceRow())
    page.append(audio.box)

    // ── Video ─────────────────────────────────────────────────────────────
    const qualityLabels: Record<RecordQuality, string> = {
        low: t("widget.screenrecord.settings.quality.low"),
        balanced: t("widget.screenrecord.settings.quality.balanced"),
        high: t("widget.screenrecord.settings.quality.high"),
    }
    const fpsLabel = (n: number) => n === 0 ? t("widget.screenrecord.settings.framerate.auto") : `${n} fps`

    const video = listGroup(t("widget.screenrecord.settings.video-group"))
    video.listBox.append(dropdownRow(
        t("widget.screenrecord.settings.quality"),
        t("widget.screenrecord.settings.quality.desc"),
        qualityLabels[recordingConfig.quality],
        QUALITIES.map(q => qualityLabels[q]),
        v => {
            const q = QUALITIES.find(k => qualityLabels[k] === v)
            if (q) recordingConfig.setQuality(q)
        },
    ))
    video.listBox.append(dropdownRow(
        t("widget.screenrecord.settings.framerate"),
        t("widget.screenrecord.settings.framerate.desc"),
        fpsLabel(recordingConfig.framerate),
        FRAMERATES.map(fpsLabel),
        v => {
            const n = FRAMERATES.find(f => fpsLabel(f) === v)
            if (n !== undefined) recordingConfig.setFramerate(n)
        },
    ))
    // No render node, no row: a toggle that cannot change anything is worse than
    // an absent one. The stored value still exists and comes back with the GPU.
    if (hardwareAvailable()) {
        video.listBox.append(toggleRow(
            t("widget.screenrecord.settings.hardware"),
            t("widget.screenrecord.settings.hardware.desc"),
            recordingConfig.hardware,
            v => recordingConfig.setHardware(v),
        ))
    }
    page.append(video.box)

    // ── File ──────────────────────────────────────────────────────────────
    const formatLabels: Record<RecordFormat, string> = { mp4: "MP4", mkv: "MKV", webm: "WebM" }
    const file = listGroup(t("widget.screenrecord.settings.file-group"))
    file.listBox.append(dropdownRow(
        t("widget.screenrecord.settings.format"),
        t("widget.screenrecord.settings.format.desc"),
        formatLabels[recordingConfig.format],
        FORMATS.map(f => formatLabels[f]),
        v => {
            const f = FORMATS.find(k => formatLabels[k] === v)
            if (f) recordingConfig.setFormat(f)
        },
    ))
    file.listBox.append(saveDirRow())
    page.append(file.box)

    return page
}

// ── Widget registration ───────────────────────────────────────────────────────

const screenrecordWidget: AtomicWidget = {
    id: "screenrecord",
    category: "utilities",
    barOrder: 60,
    name: t("widget.screenrecord.name"),
    icon: Icons.record,
    locations: ["bar", "cc"],
    defaultInCc: false,   // off by default — optional/power feature; available to add
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    buildSettings,
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
    // Recording fills the capsule with the ACCENT, exactly like every other tile
    // that is switched on (dark_mode, night_light, focus…) — no `activeColorHex`,
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
}

export default screenrecordWidget
