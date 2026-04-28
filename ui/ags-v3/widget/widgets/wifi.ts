import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { WifiWidget } from "../control-center/Toggles"
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
    const wifi = AstalNetwork.get_default()?.wifi

    const getIcon = () => (wifi as any)?.enabled === false ? Icons.wifiOff : Icons.wifi

    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })

    if (wifi) {
        const sigId = (wifi as any).connect("notify", () => { image.gicon = getIcon() })
        image.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
    }

    // ── Popover content ──────────────────────────────────────────
    const ssid    = infoRow(t("widget.wifi.row.network"), () => (wifi as any)?.ssid        || "—")
    const state   = infoRow(t("widget.wifi.row.status"),  () => (wifi as any)?.enabled === false ? t("widget.wifi.row.disabled") : t("cc.wifi.sub.connected"))
    const ip      = infoRow("IP",     () => (wifi as any)?.ip4_address || (wifi as any)?.ip4Address || "—")

    const updates = [ssid.update, state.update, ip.update]

    const popBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 14,
        margin_end: 14,
        width_request: 220,
    })
    popBox.append(new Gtk.Label({ label: t("cc.wifi.name"), css_classes: ["bar-popover-title"], halign: Gtk.Align.START }))
    popBox.append(new Gtk.Separator({ css_classes: ["bar-popover-sep"], margin_top: 2, margin_bottom: 2 }))
    popBox.append(ssid.row)
    popBox.append(state.row)
    popBox.append(ip.row)

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

const wifiWidget: AtomicWidget = {
    id: "wifi",
    name: t("cc.wifi.name"),
    icon: Icons.wifi,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.WIDE],
    buildContent: (size) => WifiWidget().buildContent(size),
    buildBarContent,
}

export default wifiWidget
