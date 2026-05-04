import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

// ── Types ─────────────────────────────────────────────────────────────────────

type CaptureMode   = "area" | "screen" | "window"
type CaptureAction = "copy" | "save"

// ── grim commands ─────────────────────────────────────────────────────────────

const SAVE_DIR = GLib.build_filenamev([GLib.get_home_dir(), "Pictures"])

function saveFilename(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    return `${SAVE_DIR}/Screenshot_${ts}.png`
}

function buildCommand(mode: CaptureMode, action: CaptureAction): string {
    const geometry = mode === "area"
        ? '$(slurp -d)'
        : mode === "window"
            ? '$(hyprctl -j activewindow | jq -r \'"\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"\')'
            : null

    const grimFlag = geometry ? `-g "${geometry}"` : ""

    if (action === "copy") {
        return `grim ${grimFlag} - | wl-copy`.trim()
    } else {
        const file = saveFilename()
        return `grim ${grimFlag} "${file}" && notify-send "${t("widget.screenshot.saved")}" "${file}"`.trim()
    }
}

async function capture(mode: CaptureMode, action: CaptureAction, onClose: () => void) {
    // Close the overlay first, then wait for it to disappear before capturing
    onClose()
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        resolve(null)
        return GLib.SOURCE_REMOVE
    }))
    try {
        await execAsync(["bash", "-c", buildCommand(mode, action)])
    } catch (e) {
        console.error("[Screenshot] capture failed:", e)
    }
}

// ── Popover UI ────────────────────────────────────────────────────────────────

function buildScreenshotPopover(anchor: Gtk.Widget): Gtk.Popover {
    let selectedMode: CaptureMode = "area"

    // Mode buttons row
    const modes: { id: CaptureMode; label: string }[] = [
        { id: "area",   label: t("widget.screenshot.mode.area") },
        { id: "screen", label: t("widget.screenshot.mode.screen") },
        { id: "window", label: t("widget.screenshot.mode.window") },
    ]

    const modeRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        homogeneous: true,
        css_classes: ["linked"],
    })

    const modeBtns: Gtk.Button[] = []
    for (const mode of modes) {
        const btn = new Gtk.Button({ label: mode.label })
        btn.connect("clicked", () => {
            selectedMode = mode.id
            modeBtns.forEach((b, i) => {
                if (modes[i].id === selectedMode) b.add_css_class("suggested-action")
                else b.remove_css_class("suggested-action")
            })
        })
        modeRow.append(btn)
        modeBtns.push(btn)
    }
    // Initial selection
    modeBtns[0].add_css_class("suggested-action")

    // Action buttons row
    const popover = new Gtk.Popover({ autohide: true })

    const makeActionBtn = (action: CaptureAction, label: string, cssClass: string) => {
        const btn = new Gtk.Button({ label, css_classes: [cssClass], hexpand: true })
        btn.connect("clicked", () => {
            const mode = selectedMode
            capture(mode, action, () => popover.popdown())
        })
        return btn
    }

    const actionRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        homogeneous: true,
    })
    actionRow.append(makeActionBtn("copy", t("widget.screenshot.action.copy"), "flat"))
    actionRow.append(makeActionBtn("save", t("widget.screenshot.action.save"), "suggested-action"))

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_top: 14, margin_bottom: 14,
        margin_start: 14, margin_end: 14,
        width_request: 260,
    })
    box.append(modeRow)
    box.append(new Gtk.Separator())
    box.append(actionRow)

    popover.set_child(box)
    popover.set_parent(anchor)
    anchor.connect("unrealize", () => { try { popover.unparent() } catch {} })

    return popover
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({
        gicon: Icons.camera,
        pixel_size: 16,
        margin_start: 16,
        margin_end: 16,
        css_classes: ["cs-icon"],
    })

    const popover = buildScreenshotPopover(image)
    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const btn = new Gtk.Button({
            css_classes: ["cc-atomic-round-btn"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
        })
        btn.set_child(new Gtk.Image({ gicon: Icons.camera, pixel_size: 28, css_classes: ["cs-icon"] }))
        const popover = buildScreenshotPopover(btn)
        btn.connect("clicked", () => popover.popup())
        return btn
    }

    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    iconBox.append(new Gtk.Image({
        gicon: Icons.camera,
        pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon"],
    }))

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    textStack.append(new Gtk.Label({
        label: t("widget.screenshot.name"),
        css_classes: ["cc-atomic-label-bold"],
        halign: Gtk.Align.START,
    }))
    textStack.append(new Gtk.Label({
        label: t("widget.screenshot.sub"),
        css_classes: ["cc-atomic-label-dim"],
        halign: Gtk.Align.START,
    }))

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
        margin_start: 4,
    })
    inner.append(iconBox)
    inner.append(textStack)
    btn.set_child(inner)

    const popover = buildScreenshotPopover(btn)
    btn.connect("clicked", () => popover.popup())

    return btn
}

// ── Widget registration ───────────────────────────────────────────────────────

const screenshotWidget: AtomicWidget = {
    id: "screenshot",
    name: t("widget.screenshot.name"),
    icon: Icons.camera,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent,
    buildBarContent,
}

export default screenshotWidget
