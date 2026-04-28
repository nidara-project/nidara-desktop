import { Gtk } from "ags/gtk4"
import AstalBattery from "gi://AstalBattery"
import Gio from "gi://Gio"
import { makeExpandable } from "./bar-helpers"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

const bat = AstalBattery.get_default()

function formatTime(seconds: number): string {
    if (!seconds || seconds <= 0) return ""
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0 && m > 0) return `${h}h ${m}m`
    if (h > 0) return `${h}h`
    return `${m}m`
}

function getIcon(): Gio.FileIcon | string {
    if (!bat) return Icons.battery
    return bat.icon_name || Icons.battery
}

function getSummary(): string {
    if (!bat) return "—"
    const pct = Math.round(bat.percentage)
    if (bat.charging || bat.charged) {
        const timeStr = formatTime(bat.time_to_full)
        return timeStr ? `${pct}% · ${timeStr}` : `${pct}% · ${t("widget.battery.state.cargando")}`
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
        if (icon) {
            const ic = getIcon()
            if (typeof ic === "string") icon.icon_name = ic; else icon.gicon = ic
        }
    })
    widget.connect("unrealize", () => { try { bat.disconnect(sigId) } catch {} })

    return widget
}

function buildContent(_size: WidgetSize): Gtk.Widget {
    if (!bat) {
        const label = new Gtk.Label({
            label: t("widget.battery.label.bateria-no-disponible"),
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
        const ic = getIcon()
        if (typeof ic === "string") icon.icon_name = ic; else icon.gicon = ic
        pctLabel.label = `${pct}%`
        if (bat.charged) {
            stateLabel.label = t("widget.battery.state.cargado")
        } else if (bat.charging) {
            const timeStr = formatTime(bat.time_to_full)
            stateLabel.label = timeStr ? `${t("widget.battery.state.cargando")} · ${timeStr}` : t("widget.battery.state.cargando")
        } else {
            const timeStr = formatTime(bat.time_to_empty)
            stateLabel.label = timeStr ? `${timeStr} · ${t("widget.battery.state.descargando")}` : t("widget.battery.state.descargando")
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
    name: t("widget.battery.name"),
    icon: Icons.battery,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE],
    buildContent,
    buildBarContent,
}

export default batteryWidget
