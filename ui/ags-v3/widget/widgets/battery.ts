import { Gtk } from "ags/gtk4"
import AstalBattery from "gi://AstalBattery"
import { makeExpandable } from "./bar-helpers"
import { AtomicWidget, WidgetSize } from "../control-center/Types"

const bat = AstalBattery.get_default()

function formatTime(seconds: number): string {
    if (!seconds || seconds <= 0) return ""
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0 && m > 0) return `${h}h ${m}m`
    if (h > 0) return `${h}h`
    return `${m}m`
}

function getIcon(): string {
    if (!bat) return "battery-missing-symbolic"
    return bat.icon_name || "battery-missing-symbolic"
}

function getSummary(): string {
    if (!bat) return "—"
    const pct = Math.round(bat.percentage)
    if (bat.charging || bat.charged) {
        const timeStr = formatTime(bat.time_to_full)
        return timeStr ? `${pct}% · ${timeStr}` : `${pct}% · Cargando`
    }
    const timeStr = formatTime(bat.time_to_empty)
    return timeStr ? `${pct}% · ${timeStr}` : `${pct}%`
}

function buildBarContent(): Gtk.Widget {
    if (!bat) return new Gtk.Box({ visible: false })

    const widget = makeExpandable({
        getIcon,
        getText: getSummary,
    })

    const sigId = bat.connect("notify", () => {
        const icon = (widget as any).get_first_child()
        if (icon?.icon_name !== undefined) icon.icon_name = getIcon()
    })
    widget.connect("unrealize", () => { try { bat.disconnect(sigId) } catch {} })

    return widget
}

function buildContent(_size: WidgetSize): Gtk.Widget {
    if (!bat) {
        const label = new Gtk.Label({
            label: "Batería no disponible",
            css_classes: ["settings-placeholder"],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        })
        return label
    }

    const pctLabel = new Gtk.Label({
        css_classes: ["bar-popover-val"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    const stateLabel = new Gtk.Label({
        css_classes: ["bar-popover-key"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    const icon = new Gtk.Image({
        pixel_size: 32,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })

    const sync = () => {
        const pct = Math.round(bat.percentage)
        icon.icon_name = getIcon()
        pctLabel.label = `${pct}%`
        if (bat.charged) {
            stateLabel.label = "Cargado"
        } else if (bat.charging) {
            const t = formatTime(bat.time_to_full)
            stateLabel.label = t ? `Cargando · ${t}` : "Cargando"
        } else {
            const t = formatTime(bat.time_to_empty)
            stateLabel.label = t ? `${t} restantes` : "Descargando"
        }
    }

    sync()

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    box.append(icon)
    box.append(pctLabel)
    box.append(stateLabel)

    const sigId = bat.connect("notify", sync)
    box.connect("unrealize", () => { try { bat.disconnect(sigId) } catch {} })

    const outer = new Gtk.CenterBox()
    outer.set_center_widget(box)
    return outer
}

const batteryWidget: AtomicWidget = {
    id: "battery",
    name: "Batería",
    icon: "battery-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE],
    buildContent,
    buildBarContent,
}

export default batteryWidget
