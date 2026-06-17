import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
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

function buildBarContent(): Gtk.Widget {
    const wifi = AstalNetwork.get_default()?.wifi
    const getIcon = () => (wifi as any)?.enabled === false ? Icons.wifiOff : Icons.wifi
    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    if (wifi) {
        // notify::enabled ONLY — the icon depends solely on `enabled`. The generic
        // "notify" fires on every property churn (strength/scanning) and re-set the
        // gicon each time → gtk_image_clear → queue_draw → a full bar re-blur every
        // frame for an icon that never visually changes. Guard the assignment too.
        const sigId = (wifi as any).connect("notify::enabled", () => { const ic = getIcon(); if (image.gicon !== ic) image.gicon = ic })
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
            css_classes: ["nd-icon"],
        })
        if (wifi) {
            const sigId = (wifi as any).connect("notify::enabled", () => { const ic = getIcon(); if (icon.gicon !== ic) icon.gicon = ic })
            box.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
        }
        box.append(icon)
        return box
    }

    const inner = buildCapsuleInner(getIcon, () => t("cc.wifi.name"), getSub)

    if (wifi) {
        // Specific signals only — inner.update reads enabled (icon) + ssid (subtitle);
        // the generic "notify" stormed a full re-blur on every strength/scan churn.
        const sigIdE = (wifi as any).connect("notify::enabled", inner.update)
        const sigIdS = (wifi as any).connect("notify::ssid", inner.update)
        inner.box.connect("unrealize", () => { try { (wifi as any).disconnect(sigIdE); (wifi as any).disconnect(sigIdS) } catch {} })
    }
    return wrapCapsuleTile(inner.box)
}

function buildInfoPanel(): Gtk.Widget {
    const wifi = AstalNetwork.get_default()?.wifi

    const ssid  = infoRow(t("widget.wifi.row.network"), () => (wifi as any)?.ssid || "—")
    const state = infoRow(t("widget.wifi.row.status"), () => {
        if ((wifi as any)?.enabled === false) return t("widget.wifi.row.disabled")
        return (wifi as any)?.ssid ? t("cc.wifi.sub.connected") : t("cc.wifi.sub.disconnected")
    })
    const ip = infoRow("IP", () => Net.getIp(wifi))

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
        Net.setWifiEnabled(state)
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
    isAvailable: () => !!AstalNetwork.get_default()?.wifi,
    watchAvailable: (cb) => { AstalNetwork.get_default()?.connect("notify::wifi", cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 3,
}

export default wifiWidget
