import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"

import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import status from "../core/Status"

// ── Types ─────────────────────────────────────────────────────────────────────

type RecordMode = "screen" | "region"

// ── State ─────────────────────────────────────────────────────────────────────

const SAVE_DIR = GLib.build_filenamev([GLib.get_home_dir(), "Videos"])

function saveFilename(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    return `${SAVE_DIR}/Recording_${ts}.mp4`
}

async function startRecording(mode: RecordMode, withAudio: boolean, onClose: () => void) {
    // Close overlay first so it doesn't appear in region selector
    onClose()
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        resolve(null)
        return GLib.SOURCE_REMOVE
    }))

    // Ensure Videos directory exists
    GLib.mkdir_with_parents(SAVE_DIR, 0o755)

    const args: string[] = ["wf-recorder"]
    if (withAudio) args.push("--audio")

    if (mode === "region") {
        let geo: string
        try {
            geo = (await execAsync(["slurp"])).trim()
        } catch {
            return // user cancelled slurp
        }
        args.push("-g", geo)
    }

    const outFile = saveFilename()
    args.push("-f", outFile)

    status.recording = true
    try {
        await execAsync(args)
    } catch {
        // wf-recorder exits with non-zero on SIGINT — that's normal
    } finally {
        status.recording = false
        execAsync(["notify-send", t("widget.screenrecord.saved"), outFile]).catch(() => {})
    }
}

export async function stopRecording() {
    await execAsync(["pkill", "-SIGINT", "wf-recorder"]).catch(() => {})
}

// ── Recording elapsed timer ────────────────────────────────────────────────────

function makeElapsedLabel(): Gtk.Label {
    const label = new Gtk.Label({ label: "0:00", css_classes: ["rec-elapsed"] })
    let startTime = 0
    let timerId = 0

    const onRecordingChanged = () => {
        if (status.recording) {
            startTime = Date.now()
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000)
                const m = Math.floor(elapsed / 60)
                const s = elapsed % 60
                label.label = `${m}:${String(s).padStart(2, "0")}`
                return GLib.SOURCE_CONTINUE
            })
        } else {
            if (timerId) { GLib.source_remove(timerId); timerId = 0 }
            label.label = "0:00"
        }
    }

    const sigId = status.connect("notify::recording", onRecordingChanged)
    label.connect("unrealize", () => {
        safeDisconnect(status, sigId)
        if (timerId) { GLib.source_remove(timerId); timerId = 0 }
    })

    return label
}

// ── Record controls (shared by bar expansion + CC popover) ───────────────────

function buildRecordPopoverContent(onClose: () => void): Gtk.Widget {
    let selectedMode: RecordMode = "screen"
    let withAudio = false

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
    audioSwitch.connect("notify::active", () => { withAudio = audioSwitch.active })
    // nidara-row-title gives it the mode-aware text colour (a plain Gtk.Label
    // inherits an unreliable default that rendered white in light mode too).
    const audioLabel = new Gtk.Label({ label: t("widget.screenrecord.audio"), hexpand: true, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] })
    audioRow.append(audioLabel)
    audioRow.append(audioSwitch)

    const startBtn = new Gtk.Button({ label: t("widget.screenrecord.start"), css_classes: ["suggested-action"], hexpand: true })
    startBtn.connect("clicked", () => startRecording(selectedMode, withAudio, onClose))

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: PANEL_W.sm })
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
    // recording = "Recording…" + a live elapsed timer in the subtitle slot.
    const pad2 = (n: number) => String(n).padStart(2, "0")
    let recStart = 0
    const elapsedStr = () => {
        const s = Math.max(0, Math.floor((Date.now() - recStart) / 1000))
        return `${Math.floor(s / 60)}:${pad2(s % 60)}`
    }
    const getIcon  = () => status.recording ? Icons.recordStop : Icons.record
    const getTitle = () => status.recording ? t("widget.screenrecord.recording") : t("widget.screenrecord.name")
    const getSub   = () => status.recording ? elapsedStr() : ""

    const inner = buildCapsuleInner(getIcon, getTitle, getSub)

    const setClass = (w: Gtk.Widget, cls: string, on: boolean) => {
        if (on) w.add_css_class(cls); else w.remove_css_class(cls)
    }
    let tickId = 0
    const stopTick = () => { if (tickId) { GLib.source_remove(tickId); tickId = 0 } }
    const syncRec = () => {
        const rec = status.recording
        if (rec) recStart = Date.now()
        inner.update()                               // re-reads icon/title/sub
        setClass(inner.iconBox,  "rec-active-bg", rec)
        setClass(inner.icon,     "rec-stop-icon", rec)
        setClass(inner.label,    "rec-label",     rec)
        setClass(inner.subLabel, "rec-elapsed",   rec)
        stopTick()
        if (rec) tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            inner.subLabel.label = getSub()
            return GLib.SOURCE_CONTINUE
        })
    }
    const sigId = status.connect("notify::recording", syncRec)
    inner.box.connect("unrealize", () => { safeDisconnect(status, sigId); stopTick() })
    syncRec()

    return wrapCapsuleTile(inner.box)
}

// ── Bar icon (dynamic recording state indicator) ──────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: Icons.record, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    const syncState = () => {
        image.gicon = status.recording ? Icons.recordStop : Icons.record
        if (status.recording) image.add_css_class("rec-bar-active")
        else image.remove_css_class("rec-bar-active")
    }
    const sigId = status.connect("notify::recording", syncState)
    image.connect("unrealize", () => { safeDisconnect(status, sigId) })
    syncState()
    return image
}

// ── Bar expansion panel content ───────────────────────────────────────────────

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    // Stack switches between setup (idle) and active (recording) views
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 150 })

    // ── Idle page ──────────────────────────────────────────────
    const idlePage = buildRecordPopoverContent(onClose)
    stack.add_named(idlePage, "idle")

    // ── Recording page ─────────────────────────────────────────
    const elapsed = makeElapsedLabel()
    const stopBtn = new Gtk.Button({ label: t("widget.screenrecord.stop"), css_classes: ["destructive-action"], hexpand: true })
    stopBtn.connect("clicked", () => stopRecording())
    const recBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: PANEL_W.sm })
    recBox.append(elapsed)
    recBox.append(new Gtk.Separator())
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
    icon: Icons.record,
    locations: ["bar", "cc"],
    defaultInCc: false,   // off by default — optional/power feature; available to add
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 2,
}

export default screenrecordWidget
