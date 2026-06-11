import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../control-center/Toggles"

import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import hs from "../../core/HyprlandState"

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
    // Window geometry comes from HyprlandState at this point — capture() calls
    // this AFTER the close-delay, so the focused client is current (this used to
    // be a `hyprctl | jq` pipeline evaluated inside bash; same moment, no jq).
    const focused = hs.focusedClient
    const geometry = mode === "area"
        ? '$(slurp -d)'
        : mode === "window" && focused
            ? `${focused.x},${focused.y} ${focused.width}x${focused.height}`
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

// ── Shared control builder (used by bar expansion + CC popover) ───────────────

function buildControls(onClose: () => void): Gtk.Widget {
    let selectedMode: CaptureMode = "area"

    const modes: { id: CaptureMode; label: string }[] = [
        { id: "area",   label: t("widget.screenshot.mode.area") },
        { id: "screen", label: t("widget.screenshot.mode.screen") },
        { id: "window", label: t("widget.screenshot.mode.window") },
    ]

    const modeRow = new Gtk.Box({ spacing: 4, homogeneous: true })
    const modeBtns: Gtk.Button[] = []
    for (const mode of modes) {
        const btn = new Gtk.Button({ label: mode.label, css_classes: ["crystal-seg-btn"] })
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
    modeBtns[0].add_css_class("suggested-action")

    const makeActionBtn = (action: CaptureAction, label: string, cssClass: string) => {
        const btn = new Gtk.Button({ label, css_classes: [cssClass], hexpand: true })
        btn.connect("clicked", () => capture(selectedMode, action, onClose))
        return btn
    }

    const actionRow = new Gtk.Box({ spacing: 6, homogeneous: true })
    actionRow.append(makeActionBtn("copy", t("widget.screenshot.action.copy"), "flat"))
    actionRow.append(makeActionBtn("save", t("widget.screenshot.action.save"), "suggested-action"))

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: PANEL_W.lg })
    box.append(modeRow)
    box.append(new Gtk.Separator())
    box.append(actionRow)
    return box
}

// ── Bar icon ──────────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.camera, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
}

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildControls(onClose)
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        box.append(new Gtk.Image({ gicon: Icons.camera, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] }))
        return box
    }

    return wrapCapsuleTile(buildCapsuleInner(() => Icons.camera, () => t("widget.screenshot.name"), () => t("widget.screenshot.sub")).box)
}

// ── Widget registration ───────────────────────────────────────────────────────

const screenshotWidget: AtomicWidget = {
    id: "screenshot",
    name: t("widget.screenshot.name"),
    icon: Icons.camera,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 2,
}

export default screenshotWidget
