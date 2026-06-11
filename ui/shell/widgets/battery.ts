import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import AstalBattery from "gi://AstalBattery"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { wrapCapsuleTile } from "../surfaces/control-center/Toggles"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import Theme from "../core/ThemeManager"

const bat = AstalBattery.get_default()

// A real battery device is present (false on desktops, where the display
// device exists but reports is_present = false).
const present = () => !!bat && bat.is_present

// AstalBattery.percentage is a fraction 0..1 (per the GI docs), NOT 0..100.
const frac = () => (present() ? Math.max(0, Math.min(1, bat!.percentage)) : 0)
const pctText = () => `${Math.round(frac() * 100)}%`

// Semantic fills (NOT the theme accent — accent is reserved for selection). These
// match the danger/success seeds in FluidCrystal.ts (#ED5F5D / #79B757).
const RED:   [number, number, number] = [0.93, 0.37, 0.36]
const GREEN: [number, number, number] = [0.47, 0.72, 0.34]
const LOW_THRESHOLD = 0.15

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
    if (bat!.charged) return t("widget.battery.state.cargado")
    if (bat!.charging) {
        const ts = formatTime(bat!.time_to_full)
        return ts ? `${t("widget.battery.state.cargando")} · ${ts}` : t("widget.battery.state.cargando")
    }
    const ts = formatTime(bat!.time_to_empty)
    return ts ? `${t("widget.battery.state.descargando")} · ${ts}` : t("widget.battery.state.descargando")
}

// ── Cairo battery glyph (fill ∝ exact charge, green when charging, red when low) ──
function roundRect(cr: any, x: number, y: number, w: number, h: number, r: number) {
    if (w <= 0 || h <= 0) return
    r = Math.min(r, w / 2, h / 2)
    cr.newPath()
    cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2)
    cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI)
    cr.arc(x + r,     y + r,     r, Math.PI,      1.5 * Math.PI)
    cr.closePath()
}

// gh = glyph height in px; the body is ~2× as wide plus a small terminal nub.
// fill=true lets the DrawingArea fill its parent (e.g. the 48px icon circle) so the
// glyph is centred by the draw_func in the full allocation — robust against box quirks.
function makeGlyph(gh: number, fill = false): Gtk.DrawingArea {
    const gw = Math.round(gh * 2.0)
    const da = new Gtk.DrawingArea(fill
        ? { hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL }
        : { width_request: gw + 3, height_request: gh + 2, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        const f = frac()
        const charging = present() && bat!.charging
        const c = Theme.isDark ? 1 : 0
        const stroke = gh >= 24 ? 1.6 : 1.2
        const r = gh * 0.28

        // Glyph centred in the allocation.
        const nubW = Math.max(1.5, gw * 0.05)
        const bodyW = gw - nubW - 1
        const x0 = (w - gw) / 2
        const y0 = (h - gh) / 2

        // Body outline.
        roundRect(cr, x0 + stroke / 2, y0 + stroke / 2, bodyW - stroke, gh - stroke, r)
        cr.setLineWidth(stroke)
        cr.setSourceRGBA(c, c, c, 0.5)
        cr.stroke()

        // Terminal nub on the right.
        const nubH = gh * 0.42
        roundRect(cr, x0 + bodyW, y0 + (gh - nubH) / 2, nubW, nubH, nubW * 0.4)
        cr.setSourceRGBA(c, c, c, 0.5)
        cr.fill()

        // Proportional fill.
        const pad = stroke + 1.5
        const innerW = bodyW - 2 * pad
        const fillW = Math.max(0, innerW * f)
        if (fillW > 0.5) {
            let fr = c, fg = c, fb = c, fa = 0.85
            if (charging)          { [fr, fg, fb] = GREEN; fa = 0.95 }
            else if (f <= LOW_THRESHOLD) { [fr, fg, fb] = RED; fa = 0.95 }
            roundRect(cr, x0 + pad, y0 + pad, fillW, gh - 2 * pad, Math.max(0.5, r - pad))
            cr.setSourceRGBA(fr, fg, fb, fa)
            cr.fill()
        }
    })
    return da
}

// Connect a sync callback to the battery's notify signal with auto-cleanup.
function bindSync(root: Gtk.Widget, sync: () => void) {
    sync()
    if (!bat) return
    const id = bat.connect("notify", sync)
    root.connect("unrealize", () => { try { bat.disconnect(id) } catch {} })
}

// Desktops / no battery: a plain dim icon, same footprint as any other tile.
function notPresent(): Gtk.Widget {
    const box = new Gtk.Box({ hexpand: true, vexpand: true })
    box.append(new Gtk.Image({
        gicon: Icons.battery, pixel_size: 28, opacity: 0.5,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true, css_classes: ["cs-icon"],
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
            label: t("widget.battery.label.bateria-no-disponible"),
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
        return new Gtk.Image({ gicon: Icons.battery, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
    }
    const glyph = makeGlyph(11)
    glyph.margin_start = 16
    glyph.margin_end = 16
    bindSync(glyph, () => glyph.queue_draw())
    return glyph
}

const batteryWidget: AtomicWidget = {
    id: "battery",
    name: t("widget.battery.name"),
    icon: Icons.battery,
    locations: ["bar", "cc"],
    defaultInCc: false,   // situational (laptops only) — available to add, but not seeded by default
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
