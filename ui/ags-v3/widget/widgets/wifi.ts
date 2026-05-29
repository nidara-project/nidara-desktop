import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import AstalNetwork from "gi://AstalNetwork"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

function getIp(service: any): string {
    if (!service) return "—"
    const addr = (service as any)?.ip4_address
    if (addr && addr !== "None") return String(addr)
    try {
        const addrs = service.device?.get_ip4_config()?.get_addresses()
        if (addrs?.length > 0) return String(addrs[0].get_address())
    } catch {}
    return "—"
}

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
    return image
}

function buildContent(size: WidgetSize): Gtk.Widget {
    const wifi = AstalNetwork.get_default()?.wifi
    const getIcon = () => (wifi as any)?.enabled === false ? Icons.wifiOff : Icons.wifi
    const getSub = () => {
        if (!wifi) return t("cc.wifi.sub.off")
        const ssid = (wifi as any)?.ssid
        if (ssid) return ssid
        return (wifi as any)?.enabled === false ? t("cc.wifi.sub.off") : t("cc.wifi.sub.disconnected")
    }

    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        const icon = new Gtk.Image({
            gicon: getIcon(), pixel_size: 28,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
            css_classes: ["cs-icon"],
        })
        if (wifi) {
            const sigId = (wifi as any).connect("notify", () => { icon.gicon = getIcon() })
            box.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
        }
        box.append(icon)
        return box
    }

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
        margin_start: 4,
    })
    const icon = new Gtk.Image({
        gicon: getIcon(), pixel_size: 26,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon"],
    })
    iconBox.append(icon)

    const titleLabel = new Gtk.Label({ label: t("cc.wifi.name"), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const subLabel = new Gtk.Label({ label: getSub(), css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    textBox.append(titleLabel)
    textBox.append(subLabel)

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL, spacing: 12,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
    })
    inner.append(iconBox)
    inner.append(textBox)

    if (wifi) {
        const sigId = (wifi as any).connect("notify", () => { icon.gicon = getIcon(); subLabel.label = getSub() })
        inner.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
    }
    return inner
}

function buildInfoPanel(): Gtk.Widget {
    const wifi = AstalNetwork.get_default()?.wifi

    const ssid  = infoRow(t("widget.wifi.row.network"), () => (wifi as any)?.ssid || "—")
    const state = infoRow(t("widget.wifi.row.status"), () => {
        if ((wifi as any)?.enabled === false) return t("widget.wifi.row.disabled")
        return (wifi as any)?.ssid ? t("cc.wifi.sub.connected") : t("cc.wifi.sub.disconnected")
    })
    const ip = infoRow("IP", () => getIp(wifi))

    const updateAll = () => { ssid.update(); state.update(); ip.update() }
    updateAll()

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true, margin_top: 4 })
    box.append(ssid.row)
    box.append(state.row)
    box.append(ip.row)

    if (wifi) {
        const sigId = (wifi as any).connect("notify", updateAll)
        box.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
    }

    return box
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const wifi = AstalNetwork.get_default()?.wifi

    const sw = new Gtk.Switch({ active: (wifi as any)?.enabled !== false, valign: Gtk.Align.CENTER })
    sw.connect("state-set", (_sw: Gtk.Switch, state: boolean) => {
        execAsync(["nmcli", "radio", "wifi", state ? "on" : "off"]).catch(() => {})
        return false
    })
    if (wifi) {
        const sigId = (wifi as any).connect("notify::enabled", () => { sw.active = (wifi as any)?.enabled !== false })
        sw.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
    }

    const switchLabel = new Gtk.Label({ label: t("cc.wifi.name"), css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const switchRow = new Gtk.Box({ spacing: 8, margin_bottom: 4 })
    switchRow.append(switchLabel)
    switchRow.append(sw)

    const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 2, margin_bottom: 2 })

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    outer.append(switchRow)
    outer.append(sep)
    outer.append(buildInfoPanel())
    return outer
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    return buildInfoPanel()
}

const wifiWidget: AtomicWidget = {
    id: "wifi",
    name: t("cc.wifi.name"),
    icon: Icons.wifi,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 3,
}

export default wifiWidget
