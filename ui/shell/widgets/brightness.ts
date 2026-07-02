import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { makeHSlider, makeVerticalFillTile } from "../common/Slider"
import { pollWhileMapped } from "../common/poll"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

// ── brightnessctl helpers ─────────────────────────────────────────────────────

let _cachedPct = 100
let _cachedMax = 0   // the device max never changes — fetch it once, not per poll

async function fetchBrightness(): Promise<number> {
    try {
        if (!_cachedMax) {
            _cachedMax = parseInt((await execAsync(["brightnessctl", "m"])).trim()) || 0
            if (!_cachedMax) return _cachedPct
        }
        const cur = parseInt((await execAsync(["brightnessctl", "g"])).trim())
        _cachedPct = Math.round(cur / _cachedMax * 100)
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

// Dispatch by tier: Small=icon, Medium=1×2 vertical, Large=4×1 horizontal.
function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) return buildBrightnessIcon()
    if (size === WidgetSize.TALL) return buildVertical()
    return buildHorizontal()
}

// Small (1×1): centered indicator icon, mirroring the bar icon.
function buildBrightnessIcon(): Gtk.Widget {
    return new Gtk.Image({
        gicon: Icons.sun, pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["nd-icon"],
    })
}

// Medium (1×2): capsule-filling vertical slider (fill rises edge-to-edge, % on top,
// sun icon at the bottom — shared layout with volume via makeVerticalFillTile).
function buildVertical(): Gtk.Widget {
    // Brightness has no change signal — poll every 2s, but ONLY while the tile is
    // mapped (CC tiles are built once and hidden, never destroyed, so an unmapped
    // timer would spawn brightnessctl for the whole session). Skip polling briefly
    // after a user change so the in-flight result doesn't snap the slider back.
    let ignoreUntil = 0
    let sync: ((v: number) => void) | undefined
    const tile = makeVerticalFillTile(Icons.sun, {
        value: _cachedPct,
        onChange: (v) => { ignoreUntil = GLib.get_monotonic_time() + 800_000; setBrightness(v) },
        onExtChange: (cb) => { sync = cb; return () => { sync = undefined } },
    })
    pollWhileMapped(tile, 2000, () => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
        fetchBrightness().then(v => sync?.(v))
    })
    return tile
}

// Large (4×1): horizontal slider.
function buildHorizontal(): Gtk.Widget {
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
    let sliderSync: ((v: number) => void) | undefined

    const slider = makeHSlider({
        value: _cachedPct,
        onChange: (v) => {
            ignoreUntil = GLib.get_monotonic_time() + 500_000
            setBrightness(v)
        },
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => { sliderSync = cb; return () => { sliderSync = undefined } },
    })

    box.append(new Gtk.Image({ gicon: Icons.moon, pixel_size: 14, opacity: 0.5, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] }))
    box.append(slider)
    box.append(new Gtk.Image({ gicon: Icons.sun,  pixel_size: 16, opacity: 0.6, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] }))
    box.append(valueLabel)

    // Poll only while visible (see buildVertical); the map-tick doubles as the initial fetch.
    pollWhileMapped(box, 2000, () => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
        fetchBrightness().then(v => sliderSync?.(v))
    })

    return box
}

// ── Bar widget (icon only) ────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.sun, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
}

// ── Bar expansion panel content ───────────────────────────────────────────────

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const valueLabel = new Gtk.Label({
        label: `${_cachedPct}%`,
        css_classes: ["bar-popover-value"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    let ignoreUntil = 0
    let sliderSync: ((v: number) => void) | undefined

    const slider = makeHSlider({
        value: _cachedPct,
        onChange: (v) => {
            ignoreUntil = GLib.get_monotonic_time() + 500_000
            setBrightness(v)
        },
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: (cb) => { sliderSync = cb; return () => { sliderSync = undefined } },
        width_request: PANEL_W.sm,
    })

    const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    row.append(new Gtk.Image({ gicon: Icons.moon, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    row.append(slider)
    row.append(valueLabel)

    // Poll only while visible (see buildVertical); the map-tick doubles as the initial fetch.
    pollWhileMapped(row, 2000, () => {
        if (GLib.get_monotonic_time() < ignoreUntil) return
        fetchBrightness().then(v => sliderSync?.(v))
    })

    return row
}

// ── Widget registration ───────────────────────────────────────────────────────

// Desktops have no controllable backlight (brightnessctl drives /sys/class/backlight,
// which only laptops/eDP panels populate). No hotplug signal exists → no watchAvailable.
function hasBacklight(): boolean {
    try {
        const dir = GLib.Dir.open("/sys/class/backlight", 0)
        const has = dir.read_name() !== null
        dir.close()
        return has
    } catch { return false }
}

const brightnessWidget: AtomicWidget = {
    id: "brightness",
    category: "system",
    barOrder: 30,
    name: t("widget.brightness.name"),
    icon: Icons.sun,
    locations: ["bar", "cc"],
    isAvailable: hasBacklight,
    defaultSize: WidgetSize.FULL_WIDTH,
    // Slider tier mapping: Small=icon, Medium=1×2 vertical, Large=4×1 wide.
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.TALL, WidgetSize.FULL_WIDTH],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    // Gauge fill for the TALL tile only (see volume.ts for the same split).
    // Brightness has no change signal — same "poll and redraw" reality the
    // buildVertical/buildHorizontal panels already live with — so watchActive
    // just re-queues a draw every 2s; _cachedPct itself is kept fresh by
    // whichever poller (bar/CC/detail) is currently live.
    getFill: (size) => size === WidgetSize.TALL ? _cachedPct / 100 : 0,
    watchActive: (cb) => {
        const id = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => { cb(); return GLib.SOURCE_CONTINUE })
        return () => { try { GLib.source_remove(id) } catch {} }
    },
}

export default brightnessWidget
