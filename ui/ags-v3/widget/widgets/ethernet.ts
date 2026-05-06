import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { EthernetWidget } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

function infoRow(label: string, getValue: () => string): { row: Gtk.Widget; update: () => void } {
    const key = new Gtk.Label({ label, css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const val = new Gtk.Label({ label: getValue(), css_classes: ["bar-popover-val"], halign: Gtk.Align.END })
    const row = new Gtk.Box({ spacing: 16 })
    row.append(key)
    row.append(val)
    return { row, update: () => { val.label = getValue() } }
}

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.ethernet, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const wired = AstalNetwork.get_default()?.wired
    const isConnected = () => (wired as any)?.internet === (AstalNetwork as any).Internet?.CONNECTED

    const iface = infoRow(t("widget.ethernet.row.interface"), () => (wired as any)?.device?.interface || "—")
    const state = infoRow(t("widget.ethernet.row.status"),    () => isConnected() ? t("cc.ethernet.sub.connected") : t("cc.ethernet.sub.disconnected"))
    const ip    = infoRow("IP",                               () => (wired as any)?.ip4_address || (wired as any)?.ip4Address || "—")
    const speed = infoRow(t("widget.ethernet.row.speed"),     () => { const s = (wired as any)?.device?.speed; return s ? `${s} Mb/s` : "—" })

    iface.update(); state.update(); ip.update(); speed.update()

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, width_request: 200 })
    box.append(iface.row)
    box.append(state.row)
    box.append(ip.row)
    box.append(speed.row)

    return box
}

const ethernetWidget: AtomicWidget = {
    id: "ethernet",
    name: t("cc.ethernet.name"),
    icon: Icons.ethernet,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent: (size) => EthernetWidget().buildContent(size),
    buildBarContent,
    buildBarExpanded,
}

export default ethernetWidget
