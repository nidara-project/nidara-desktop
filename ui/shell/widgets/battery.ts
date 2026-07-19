import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import AstalBattery from "gi://AstalBattery"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { wrapCapsuleTile } from "../surfaces/control-center/Toggles"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import { makeBatteryGlyph, batteryPresent, batteryFrac } from "../common/BatteryGlyph"

const bat = AstalBattery.get_default()

// Glyph + presence/charge readers live in common/BatteryGlyph.ts (shared with
// the island's battery-critical activity). Semantic fill colors (danger/success,
// never the accent) live there too.
const present = batteryPresent
const frac = batteryFrac
const pctText = () => `${Math.round(frac() * 100)}%`

function formatTime(seconds: number): string {
    if (!seconds || seconds <= 0) return ""
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0 && m > 0) return `${h}h ${m}m`
    if (h > 0) return `${h}h`
    return `${m}m`
}

function getStateText(): string {
    if (!present()) return "—"
    if (bat!.charged) return t("widget.battery.state.charged")
    if (bat!.charging) {
        const ts = formatTime(bat!.time_to_full)
        return ts ? `${t("widget.battery.state.charging")} · ${ts}` : t("widget.battery.state.charging")
    }
    const ts = formatTime(bat!.time_to_empty)
    return ts ? `${t("widget.battery.state.discharging")} · ${ts}` : t("widget.battery.state.discharging")
}

const makeGlyph = makeBatteryGlyph

// Connect a sync callback to the battery's notify signal with auto-cleanup.
function bindSync(root: Gtk.Widget, sync: () => void) {
    sync()
    if (!bat) return
    const id = bat.connect("notify", sync)
    root.connect("unrealize", () => safeDisconnect(bat, id))
}

// Desktops / no battery: a plain dim icon, same footprint as any other tile.
function notPresent(): Gtk.Widget {
    const box = new Gtk.Box({ hexpand: true, vexpand: true })
    box.append(new Gtk.Image({
        gicon: Icons.battery, pixel_size: 28, opacity: 0.5,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true, css_classes: ["nd-icon"],
    }))
    return box
}

// ── 1×1 (Small): glyph + percentage, centred in the round island ──────────────
function buildSingle(): Gtk.Widget {
    const glyph = makeGlyph(17)
    const pct = new Gtk.Label({ css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.CENTER })

    const group = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, halign: Gtk.Align.CENTER })
    group.append(glyph)
    group.append(pct)

    // BaseIsland forces valign FILL (overriding valign CENTER), so a plain box would
    // top-pack and pool slack below. Equal vexpand spacers genuinely centre the group.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    box.append(new Gtk.Box({ vexpand: true }))
    box.append(group)
    box.append(new Gtk.Box({ vexpand: true }))

    bindSync(box, () => { pct.label = pctText(); glyph.queue_draw() })
    return box
}

// ── 2×1 (Medium): capsule — glyph in the icon plate + percentage / state text ──
function buildWide(): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL, spacing: 12,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true, margin_start: 4,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    const glyph = makeGlyph(16, true)   // fill the 48px circle; draw_func centres the glyph
    iconBox.append(glyph)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const label = new Gtk.Label({ css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const subLabel = new Gtk.Label({ css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    textStack.append(label)
    textStack.append(subLabel)

    box.append(iconBox)
    box.append(textStack)

    bindSync(box, () => {
        label.label = pctText()
        const s = getStateText()
        subLabel.label = s
        subLabel.visible = s.length > 0
        glyph.queue_draw()
    })
    return wrapCapsuleTile(box)
}

// ── 2×2 (Large): big glyph + percentage + state, centred ──────────────────────
function buildSquare(): Gtk.Widget {
    const glyph = makeGlyph(34)
    const pct = new Gtk.Label({ css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.CENTER })
    const state = new Gtk.Label({ css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.CENTER })

    const group = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER })
    group.append(glyph)
    group.append(pct)
    group.append(state)

    // BaseIsland forces valign FILL; equal vexpand spacers genuinely centre the group.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    box.append(new Gtk.Box({ vexpand: true }))
    box.append(group)
    box.append(new Gtk.Box({ vexpand: true }))

    bindSync(box, () => {
        pct.label = pctText()
        const s = getStateText()
        state.label = s
        state.visible = s.length > 0
        glyph.queue_draw()
    })
    return box
}

// ── CC tile dispatch ──────────────────────────────────────────────────────────
function buildContent(size: WidgetSize): Gtk.Widget {
    if (!present()) return notPresent()
    if (size === WidgetSize.WIDE)   return buildWide()
    if (size === WidgetSize.SQUARE) return buildSquare()
    return buildSingle()
}

// ── Info panel (shared by bar expansion + CC detail) ──────────────────────────
function buildPanel(_onClose: () => void): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: PANEL_W.lg })

    if (!present()) {
        box.append(new Gtk.Label({
            label: t("widget.battery.label.unavailable"),
            css_classes: ["bar-popover-key"],
            halign: Gtk.Align.CENTER,
            margin_top: 8, margin_bottom: 8,
        }))
        return box
    }

    const glyph = makeGlyph(28)
    const pct  = new Gtk.Label({ css_classes: ["bar-popover-val"], halign: Gtk.Align.CENTER })
    const head = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    head.append(glyph); head.append(pct)

    const state = new Gtk.Label({ css_classes: ["bar-popover-key"], halign: Gtk.Align.CENTER })

    box.append(head)
    box.append(state)

    bindSync(box, () => {
        pct.label = pctText()
        state.label = getStateText()
        glyph.queue_draw()
    })
    return box
}

// ── Bar icon (live glyph reflecting charge / charging / low) ───────────────────
function buildBarContent(): Gtk.Widget {
    if (!present()) {
        return new Gtk.Image({ gicon: Icons.battery, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    }
    const glyph = makeGlyph(11)
    glyph.margin_start = 16
    glyph.margin_end = 16
    bindSync(glyph, () => glyph.queue_draw())
    return glyph
}

const batteryWidget: AtomicWidget = {
    id: "battery",
    category: "system",
    barOrder: 40,
    name: t("widget.battery.name"),
    icon: Icons.battery,
    locations: ["bar", "cc"],
    defaultInBar: true,   // laptops only — hardware gate (isAvailable: present) hides it on desktops
    defaultInCc: false,   // situational — lives in the bar by default, available to add to the CC
    isAvailable: present,
    watchAvailable: (cb) => { bat?.connect("notify::is-present", cb) },
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded: buildPanel,
    buildCCDetail: buildPanel,
    ccDetailRows: 2,
}

export default batteryWidget
