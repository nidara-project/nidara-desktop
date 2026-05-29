import { Gtk } from "ags/gtk4"
import AstalBattery from "gi://AstalBattery"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

const bat = AstalBattery.get_default()

// A real battery device is present (false on desktops, where the display
// device exists but reports is_present = false).
const present = () => !!bat && bat.is_present

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

// ── Info panel (shared by bar expansion + CC detail) ──────────────────────────
function buildPanel(_onClose: () => void): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, width_request: 240 })

    if (!present()) {
        box.append(new Gtk.Label({
            label: t("widget.battery.label.bateria-no-disponible"),
            css_classes: ["bar-popover-key"],
            halign: Gtk.Align.CENTER,
            margin_top: 8, margin_bottom: 8,
        }))
        return box
    }

    const icon = new Gtk.Image({ gicon: Icons.battery, pixel_size: 32, css_classes: ["cs-icon"] })
    const pct  = new Gtk.Label({ css_classes: ["bar-popover-val"], halign: Gtk.Align.START })
    const head = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    head.append(icon); head.append(pct)

    const state = new Gtk.Label({ css_classes: ["bar-popover-key"], halign: Gtk.Align.START })

    box.append(head)
    box.append(state)

    const sync = () => {
        pct.label = `${Math.round(bat!.percentage)}%`
        state.label = getStateText()
    }
    sync()
    const sigId = bat!.connect("notify", sync)
    box.connect("unrealize", () => { try { bat!.disconnect(sigId) } catch {} })

    return box
}

// ── Bar icon (plain icon; tap expands the panel) ──────────────────────────────
function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.battery, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
}

// ── CC tile (centered icon, same footprint as other 1×1 widgets) ──────────────
function buildContent(_size: WidgetSize): Gtk.Widget {
    const box = new Gtk.Box({ hexpand: true, vexpand: true })
    box.append(new Gtk.Image({
        gicon: Icons.battery,
        pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon"],
    }))
    return box
}

const batteryWidget: AtomicWidget = {
    id: "battery",
    name: t("widget.battery.name"),
    icon: Icons.battery,
    locations: ["bar", "cc"],
    defaultInCc: false,   // situational (laptops only) — available to add, but not seeded by default
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE],
    buildContent,
    buildBarContent,
    buildBarExpanded: buildPanel,
    buildCCDetail: buildPanel,
    ccDetailRows: 2,
}

export default batteryWidget
