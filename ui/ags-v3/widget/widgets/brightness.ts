import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { makeHSlider } from "../common/Slider"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

// ── brightnessctl helpers ─────────────────────────────────────────────────────

let _cachedPct = 100

async function fetchBrightness(): Promise<number> {
    try {
        const [curStr, maxStr] = await Promise.all([
            execAsync(["brightnessctl", "g"]),
            execAsync(["brightnessctl", "m"]),
        ])
        const cur = parseInt(curStr.trim())
        const max = parseInt(maxStr.trim())
        if (!max) return 100
        _cachedPct = Math.round(cur / max * 100)
        return _cachedPct
    } catch {
        return _cachedPct
    }
}

function setBrightness(pct: number) {
    const clamped = Math.max(1, Math.min(100, Math.round(pct)))
    _cachedPct = clamped
    execAsync(["brightnessctl", "s", `${clamped}%`])
        .catch(e => console.error("[Brightness] set failed:", e))
}

// ── CC slider widget ──────────────────────────────────────────────────────────

function buildContent(_size: WidgetSize): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        css_classes: ["cc-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true,
        margin_start: 4, margin_end: 4,
    })

    const valueLabel = new Gtk.Label({
        label: `${_cachedPct}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    let ignoreUntil = 0

    const slider = makeHSlider({
        value: _cachedPct,
        onChange: (v) => {
            ignoreUntil = GLib.get_monotonic_time() + 500_000
            setBrightness(v)
        },
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => {
            // Poll /sys every 2s to catch external changes (keyboard shortcuts)
            const id = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
                if (GLib.get_monotonic_time() < ignoreUntil) return GLib.SOURCE_CONTINUE
                fetchBrightness().then(v => {
                    if (Math.abs(v - _cachedPct) > 1) cb(v)
                })
                return GLib.SOURCE_CONTINUE
            })
            return () => { try { GLib.source_remove(id) } catch {} }
        },
    })

    box.append(new Gtk.Image({ gicon: Icons.moon, pixel_size: 14, opacity: 0.5, valign: Gtk.Align.CENTER, css_classes: ["cs-icon"] }))
    box.append(slider)
    box.append(new Gtk.Image({ gicon: Icons.sun,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER, css_classes: ["cs-icon"] }))
    box.append(valueLabel)

    // Seed initial value
    fetchBrightness().then(v => {
        valueLabel.label = `${v}%`
    })

    return box
}

// ── Bar widget (icon + popover slider) ────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({
        gicon: Icons.sun,
        pixel_size: 16,
        margin_start: 16, margin_end: 16,
        css_classes: ["cs-icon"],
    })

    const valLabel = new Gtk.Label({
        label: `${_cachedPct}%`,
        css_classes: ["bar-popover-value"],
        halign: Gtk.Align.CENTER,
        width_chars: 5, xalign: 1.0,
    })

    const slider = makeHSlider({
        value: _cachedPct,
        onChange: (v) => setBrightness(v),
        onValueChanged: (v) => { valLabel.label = `${Math.round(v)}%` },
        onExtChange: (_cb) => () => {},
        width_request: 200,
    })

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(new Gtk.Image({ gicon: Icons.moon, pixel_size: 14, opacity: 0.5, css_classes: ["cs-icon"] }))
    row.append(slider)
    row.append(valLabel)

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 10, margin_bottom: 10,
        margin_start: 14, margin_end: 14,
    })
    popBox.append(new Gtk.Label({
        label: t("widget.brightness.name"),
        css_classes: ["bar-popover-title"],
        halign: Gtk.Align.START,
    }))
    popBox.append(row)

    const popover = new Gtk.Popover({ autohide: true, position: Gtk.PositionType.BOTTOM })
    popover.set_child(popBox)
    popover.set_parent(image)
    image.connect("unrealize", () => { try { popover.unparent() } catch {} })

    popover.connect("show", () => {
        fetchBrightness().then(v => { valLabel.label = `${v}%` })
    })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

// ── Widget registration ───────────────────────────────────────────────────────

const brightnessWidget: AtomicWidget = {
    id: "brightness",
    name: t("widget.brightness.name"),
    icon: Icons.sun,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.FULL_WIDTH,
    supportedSizes: [WidgetSize.FULL_WIDTH],
    buildContent,
    buildBarContent,
}

export default brightnessWidget
