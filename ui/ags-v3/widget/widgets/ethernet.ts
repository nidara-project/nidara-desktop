import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { EthernetWidget } from "../control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"

function infoRow(label: string, getValue: () => string): { row: Gtk.Widget; update: () => void } {
    const key = new Gtk.Label({ label, css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const val = new Gtk.Label({ label: getValue(), css_classes: ["bar-popover-val"], halign: Gtk.Align.END })
    const row = new Gtk.Box({ spacing: 16 })
    row.append(key)
    row.append(val)
    return { row, update: () => { val.label = getValue() } }
}

function buildBarContent(): Gtk.Widget {
    const wired = AstalNetwork.get_default()?.wired

    const isConnected = () =>
        (wired as any)?.internet === (AstalNetwork as any).Internet?.CONNECTED

    const getIcon = () => isConnected()
        ? "network-wired-symbolic"
        : "network-wired-disconnected-symbolic"

    const image = new Gtk.Image({ icon_name: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16 })

    if (wired) {
        const sigId = (wired as any).connect("notify::internet", () => { image.icon_name = getIcon() })
        image.connect("unrealize", () => { try { (wired as any).disconnect(sigId) } catch {} })
    }

    // ── Popover content ──────────────────────────────────────────
    const iface   = infoRow(t("widget.ethernet.row.interface"), () => (wired as any)?.device?.interface || "—")
    const state   = infoRow(t("widget.ethernet.row.status"),    () => isConnected() ? t("cc.ethernet.sub.connected") : t("cc.ethernet.sub.disconnected"))
    const ip      = infoRow("IP",                               () => (wired as any)?.ip4_address || (wired as any)?.ip4Address || "—")
    const speed   = infoRow(t("widget.ethernet.row.speed"),     () => {
        const s = (wired as any)?.device?.speed
        return s ? `${s} Mb/s` : "—"
    })

    const updates = [iface.update, state.update, ip.update, speed.update]

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 14,
        margin_end: 14,
        width_request: 220,
    })
    popBox.append(new Gtk.Label({ label: t("cc.ethernet.name"), css_classes: ["bar-popover-title"], halign: Gtk.Align.START }))
    popBox.append(new Gtk.Separator({ css_classes: ["bar-popover-sep"], margin_top: 2, margin_bottom: 2 }))
    popBox.append(iface.row)
    popBox.append(state.row)
    popBox.append(ip.row)
    popBox.append(speed.row)

    const popover = new Gtk.Popover({ autohide: true, position: Gtk.PositionType.BOTTOM })
    popover.set_child(popBox)
    popover.set_parent(image)
    popover.connect("show", () => updates.forEach(u => u()))
    image.connect("unrealize", () => { try { popover.unparent() } catch {} })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

const ethernetWidget: AtomicWidget = {
    id: "ethernet",
    name: t("cc.ethernet.name"),
    icon: "network-wired-symbolic",
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent: (size) => EthernetWidget().buildContent(size),
    buildBarContent,
}

export default ethernetWidget
