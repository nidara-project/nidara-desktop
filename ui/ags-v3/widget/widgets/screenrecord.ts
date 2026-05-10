import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"

import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import status from "../../core/Status"

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

async function stopRecording() {
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
        try { status.disconnect(sigId) } catch {}
        if (timerId) { GLib.source_remove(timerId); timerId = 0 }
    })

    return label
}

// ── Record controls (shared by bar expansion + CC popover) ───────────────────

function buildRecordPopoverContent(onClose: () => void): Gtk.Widget {
    let selectedMode: RecordMode = "screen"
    let withAudio = false

    const modeRow = new Gtk.Box({ spacing: 6, homogeneous: true, css_classes: ["linked"] })
    const screenBtn = new Gtk.Button({ label: t("widget.screenrecord.mode.screen"), css_classes: ["suggested-action"] })
    const regionBtn = new Gtk.Button({ label: t("widget.screenrecord.mode.region") })
    screenBtn.connect("clicked", () => {
        selectedMode = "screen"
        screenBtn.add_css_class("suggested-action"); regionBtn.remove_css_class("suggested-action")
    })
    regionBtn.connect("clicked", () => {
        selectedMode = "region"
        regionBtn.add_css_class("suggested-action"); screenBtn.remove_css_class("suggested-action")
    })
    modeRow.append(screenBtn)
    modeRow.append(regionBtn)

    const audioRow = new Gtk.Box({ spacing: 8 })
    const audioSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER })
    audioSwitch.connect("notify::active", () => { withAudio = audioSwitch.active })
    const audioLabel = new Gtk.Label({ label: t("widget.screenrecord.audio"), hexpand: true, halign: Gtk.Align.START })
    audioRow.append(audioLabel)
    audioRow.append(audioSwitch)

    const startBtn = new Gtk.Button({ label: t("widget.screenrecord.start"), css_classes: ["suggested-action"], hexpand: true })
    startBtn.connect("clicked", () => startRecording(selectedMode, withAudio, onClose))

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: 200 })
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
        const icon = new Gtk.Image({ gicon: status.recording ? Icons.recordStop : Icons.record, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] })
        box.append(icon)
        const syncSingle = () => { icon.gicon = status.recording ? Icons.recordStop : Icons.record }
        const sigId = status.connect("notify::recording", syncSingle)
        box.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
        return box
    }

    // ── Idle stack child ──
    const iconBoxIdle = new Gtk.Box({ css_classes: ["cc-atomic-icon-circle-bg"], halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, width_request: 48, height_request: 48 })
    iconBoxIdle.append(new Gtk.Image({ gicon: Icons.record, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] }))
    const idleText = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    idleText.append(new Gtk.Label({ label: t("widget.screenrecord.name"), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))
    idleText.append(new Gtk.Label({ label: t("widget.screenrecord.sub"), css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))
    const idleInner = new Gtk.Box({ spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, margin_start: 4, hexpand: true })
    idleInner.append(iconBoxIdle); idleInner.append(idleText)

    // ── Recording stack child ──
    const iconBoxRec = new Gtk.Box({ css_classes: ["cc-atomic-icon-circle-bg", "rec-active-bg"], halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, width_request: 48, height_request: 48 })
    iconBoxRec.append(new Gtk.Image({ gicon: Icons.recordStop, pixel_size: 22, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon", "rec-stop-icon"] }))
    const elapsed = makeElapsedLabel()
    const recText = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    recText.append(new Gtk.Label({ label: t("widget.screenrecord.recording"), css_classes: ["cc-atomic-label-bold", "rec-label"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))
    recText.append(elapsed)
    const recInner = new Gtk.Box({ spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, margin_start: 4, hexpand: true })
    recInner.append(iconBoxRec); recInner.append(recText)

    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 150, hexpand: true, hhomogeneous: true })
    stack.add_named(idleInner, "idle")
    stack.add_named(recInner, "recording")

    const outer = new Gtk.Box({ hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })
    outer.append(stack)

    const syncState = () => stack.set_visible_child_name(status.recording ? "recording" : "idle")
    const sigId = status.connect("notify::recording", syncState)
    outer.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
    syncState()

    return outer
}

// ── Bar icon (dynamic recording state indicator) ──────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: Icons.record, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
    const syncState = () => {
        image.gicon = status.recording ? Icons.recordStop : Icons.record
        if (status.recording) image.add_css_class("rec-bar-active")
        else image.remove_css_class("rec-bar-active")
    }
    const sigId = status.connect("notify::recording", syncState)
    image.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
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
    const recBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: 180 })
    recBox.append(elapsed)
    recBox.append(new Gtk.Separator())
    recBox.append(stopBtn)
    stack.add_named(recBox, "recording")

    // Keep stack in sync with recording state
    const syncStack = () => stack.set_visible_child_name(status.recording ? "recording" : "idle")
    const sigId = status.connect("notify::recording", syncStack)
    stack.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
    syncStack()

    return stack
}

// ── Widget registration ───────────────────────────────────────────────────────

const screenrecordWidget: AtomicWidget = {
    id: "screenrecord",
    name: t("widget.screenrecord.name"),
    icon: Icons.record,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 2,
}

export default screenrecordWidget
