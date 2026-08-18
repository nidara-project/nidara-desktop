import Gtk from "gi://Gtk?version=4.0"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import * as Net from "../core/NetworkService"

function infoRow(label: string, getValue: () => string): { row: Gtk.Widget; update: () => void } {
    const key = new Gtk.Label({ label, css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const val = new Gtk.Label({ label: getValue(), css_classes: ["bar-popover-val"], halign: Gtk.Align.END })
    const row = new Gtk.Box({ spacing: 16 })
    row.append(key)
    row.append(val)
    return { row, update: () => { val.label = getValue() } }
}

// The adapter is read through Net.wifi() on every call rather than captured, so a
// dongle plugged in mid-session reaches these; the watchers re-arm themselves on
// that hot-plug (see NetworkService.watchDevices — tech-debt #22/#71).
const getIcon = () => Net.wifiEnabled() ? Icons.wifi : Icons.wifiOff

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    // The radio flag ONLY — the icon depends solely on `enabled`. A wider
    // subscription re-set the gicon on every strength/scan churn →
    // gtk_image_clear → queue_draw → a full bar re-blur every frame for an icon
    // that never visually changed. Guard the assignment too.
    const dispose = Net.watchWifiEnabled(() => { const ic = getIcon(); if (image.gicon !== ic) image.gicon = ic })
    image.connect("unrealize", dispose)
    return image
}

function buildContent(size: WidgetSize): Gtk.Widget {
    const getSub = () => {
        const w = Net.wifi()
        if (!w) return t("cc.wifi.sub.off")
        if (!w.enabled) return t("cc.wifi.sub.off")
        return w.ssid || t("cc.wifi.sub.disconnected")
    }

    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        const icon = new Gtk.Image({
            gicon: getIcon(), pixel_size: 28,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
            css_classes: ["nd-icon"],
        })
        const dispose = Net.watchWifiEnabled(() => { const ic = getIcon(); if (icon.gicon !== ic) icon.gicon = ic })
        box.connect("unrealize", dispose)
        box.append(icon)
        return box
    }

    const inner = buildCapsuleInner(getIcon, () => t("cc.wifi.name"), getSub)

    // Radio flag + which network we are on: exactly what the icon and the subtitle
    // read. watchWifi would add bitrate/ip4-config churn this tile never shows.
    const dispose = Net.watchWifiNetwork(inner.update)
    inner.box.connect("unrealize", dispose)
    return wrapCapsuleTile(inner.box)
}

function buildInfoPanel(): Gtk.Widget {
    const ssid  = infoRow(t("widget.wifi.row.network"), () => Net.wifi()?.ssid || "—")
    const state = infoRow(t("widget.wifi.row.status"), () => {
        // "Disabled" means the radio is OFF, which is only sayable when there IS a
        // radio — with no adapter this stays "Disconnected", as it always did.
        const w = Net.wifi()
        if (w && !w.enabled) return t("widget.wifi.row.disabled")
        return w?.ssid ? t("cc.wifi.sub.connected") : t("cc.wifi.sub.disconnected")
    })
    const ip = infoRow("IP", () => Net.getIp(Net.wifi()))

    const updateAll = () => { ssid.update(); state.update(); ip.update() }
    updateAll()

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, hexpand: true, margin_top: 4 })
    box.append(ssid.row)
    box.append(state.row)
    box.append(ip.row)

    // This one DOES show the IP, so it takes the wider watch (ip4-config lands
    // after DHCP, well after the SSID is known).
    const dispose = Net.watchWifi(updateAll)
    box.connect("unrealize", dispose)

    return box
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = new Gtk.Switch({ active: Net.wifiEnabled(), valign: Gtk.Align.CENTER })
    sw.connect("state-set", (_sw: Gtk.Switch, state: boolean) => {
        Net.setWifiEnabled(state)
        return false
    })
    const dispose = Net.watchWifiEnabled(() => { sw.active = Net.wifiEnabled() })
    sw.connect("unrealize", dispose)

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
    category: "system",
    barOrder: 80,
    name: t("cc.wifi.name"),
    icon: Icons.wifi,
    locations: ["bar", "cc"],
    defaultInBar: true,
    isAvailable: () => !!Net.wifi(),
    watchAvailable: (cb) => { Net.watchDevices(cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 3,
}

export default wifiWidget
