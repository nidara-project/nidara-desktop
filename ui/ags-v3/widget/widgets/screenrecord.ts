import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { CrystalPopover } from "../common/CrystalPopover"
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

// ── Popover UI (idle state) ───────────────────────────────────────────────────

function buildRecordPopover(anchor: Gtk.Widget): CrystalPopover {
    let selectedMode: RecordMode = "screen"
    let withAudio = false

    const popover = new CrystalPopover({ autohide: true })

    // Mode row
    const modeRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6, homogeneous: true,
        css_classes: ["linked"],
    })

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

    // Audio toggle row
    const audioRow = new Gtk.Box({ spacing: 8 })
    const audioSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER })
    audioSwitch.connect("notify::active", () => { withAudio = audioSwitch.active })
    const audioLabel = new Gtk.Label({
        label: t("widget.screenrecord.audio"),
        hexpand: true, halign: Gtk.Align.START,
    })
    audioRow.append(audioLabel)
    audioRow.append(audioSwitch)

    // Start button
    const startBtn = new Gtk.Button({
        label: t("widget.screenrecord.start"),
        css_classes: ["suggested-action"],
        hexpand: true,
    })
    startBtn.connect("clicked", () => {
        const mode = selectedMode
        const audio = withAudio
        startRecording(mode, audio, () => popover.popdown())
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_top: 14, margin_bottom: 14,
        margin_start: 14, margin_end: 14,
        width_request: 220,
    })
    box.append(modeRow)
    box.append(new Gtk.Separator())
    box.append(audioRow)
    box.append(new Gtk.Separator())
    box.append(startBtn)

    popover.set_child(box)
    popover.set_parent(anchor)
    anchor.connect("unrealize", () => { try { popover.unparent() } catch {} })

    return popover
}

// ── CC widget content ─────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const btn = new Gtk.Button({
            css_classes: status.recording ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
        })
        const icon = new Gtk.Image({ gicon: status.recording ? Icons.recordStop : Icons.record, pixel_size: 28, css_classes: ["cs-icon"] })
        btn.set_child(icon)
        const popover = buildRecordPopover(btn)
        const syncSingle = () => {
            icon.gicon = status.recording ? Icons.recordStop : Icons.record
            btn.set_css_classes(status.recording ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
        }
        const sigId = status.connect("notify::recording", syncSingle)
        btn.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
        btn.connect("clicked", () => {
            if (status.recording) stopRecording()
            else popover.popup()
        })
        return btn
    }

    // Outer button — in idle state opens popover, in recording state stops
    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    // ── Idle stack child ──
    const iconBoxIdle = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    iconBoxIdle.append(new Gtk.Image({
        gicon: Icons.record,
        pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon"],
    }))

    const idleText = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    idleText.append(new Gtk.Label({ label: t("widget.screenrecord.name"), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))
    idleText.append(new Gtk.Label({ label: t("widget.screenrecord.sub"), css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))

    const idleInner = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, margin_start: 4, hexpand: true })
    idleInner.append(iconBoxIdle)
    idleInner.append(idleText)

    // ── Recording stack child ──
    const iconBoxRec = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg", "rec-active-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    iconBoxRec.append(new Gtk.Image({
        gicon: Icons.recordStop,
        pixel_size: 22,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon", "rec-stop-icon"],
    }))

    const elapsed = makeElapsedLabel()
    const recText = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    recText.append(new Gtk.Label({ label: t("widget.screenrecord.recording"), css_classes: ["cc-atomic-label-bold", "rec-label"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 }))
    recText.append(elapsed)

    const recInner = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, margin_start: 4, hexpand: true })
    recInner.append(iconBoxRec)
    recInner.append(recText)

    // ── Stack ──
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 150, hexpand: true, hhomogeneous: true })
    stack.add_named(idleInner, "idle")
    stack.add_named(recInner, "recording")
    btn.set_child(stack)

    const popover = buildRecordPopover(btn)

    const syncState = () => {
        if (status.recording) {
            stack.set_visible_child_name("recording")
            btn.add_css_class("rec-btn-active")
        } else {
            stack.set_visible_child_name("idle")
            btn.remove_css_class("rec-btn-active")
        }
    }
    const sigId = status.connect("notify::recording", syncState)
    btn.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })
    syncState()

    btn.connect("clicked", () => {
        if (status.recording) stopRecording()
        else popover.popup()
    })

    return btn
}

// ── Bar content ────────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({
        gicon: Icons.record,
        pixel_size: 16,
        margin_start: 16, margin_end: 16,
        css_classes: ["cs-icon"],
    })

    const popover = buildRecordPopover(image)

    const syncState = () => {
        if (status.recording) {
            image.gicon = Icons.recordStop
            image.add_css_class("rec-bar-active")
        } else {
            image.gicon = Icons.record
            image.remove_css_class("rec-bar-active")
        }
    }
    const sigId = status.connect("notify::recording", syncState)
    image.connect("unrealize", () => { try { status.disconnect(sigId) } catch {} })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => {
        if (status.recording) stopRecording()
        else popover.popup()
    })
    image.add_controller(gesture)

    return image
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
}

export default screenrecordWidget
