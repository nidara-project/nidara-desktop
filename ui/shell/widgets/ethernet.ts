import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import * as Net from "../core/NetworkService"
import { safeDisconnect } from "../core/signals"

function infoRow(label: string, getValue: () => string): { row: Gtk.Widget; update: () => void } {
    const key = new Gtk.Label({ label, css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const val = new Gtk.Label({ label: getValue(), css_classes: ["bar-popover-val"], halign: Gtk.Align.END })
    const row = new Gtk.Box({ spacing: 16 })
    row.append(key)
    row.append(val)
    return { row, update: () => { val.label = getValue() } }
}

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.ethernet, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
}

function buildContent(size: WidgetSize): Gtk.Widget {
    const wired = AstalNetwork.get_default()?.wired
    const isConnected = () => Net.wiredConnected(wired)
    const getSub = () => {
        if (!wired) return t("cc.ethernet.sub.no-cable")
        return isConnected() ? t("cc.ethernet.sub.connected") : t("cc.ethernet.sub.disconnected")
    }

    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        box.append(new Gtk.Image({
            gicon: Icons.ethernet, pixel_size: 28,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
            css_classes: ["nd-icon"],
        }))
        return box
    }

    const inner = buildCapsuleInner(() => Icons.ethernet, () => t("cc.ethernet.name"), getSub)

    if (wired) {
        const wiredId = (wired as any).connect("notify::internet", inner.update)
        inner.box.connect("unrealize", () => safeDisconnect(wired as any, wiredId))
    }
    return wrapCapsuleTile(inner.box)
}

function buildInfoPanel(): Gtk.Widget {
    const wired = AstalNetwork.get_default()?.wired
    const isConnected = () => Net.wiredConnected(wired)

    const iface = infoRow(t("widget.ethernet.row.interface"), () => (wired as any)?.device?.interface || "—")
    const state = infoRow(t("widget.ethernet.row.status"),    () => isConnected() ? t("cc.ethernet.sub.connected") : t("cc.ethernet.sub.disconnected"))
    const ip    = infoRow("IP",                               () => Net.getIp(wired))
    const speed = infoRow(t("widget.ethernet.row.speed"),     () => { const s = (wired as any)?.device?.speed; return s ? `${s} Mb/s` : "—" })

    const updateAll = () => { iface.update(); state.update(); ip.update(); speed.update() }
    updateAll()

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true, margin_top: 4 })
    box.append(iface.row)
    box.append(state.row)
    box.append(ip.row)
    box.append(speed.row)

    if (wired) {
        const wiredId = (wired as any).connect("notify", updateAll)
        const device  = (wired as any)?.device
        const devId   = device ? device.connect("notify::speed", updateAll) : 0
        box.connect("unrealize", () => {
            safeDisconnect(wired as any, wiredId)
            safeDisconnect(device, devId)
        })
    }

    return box
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    return buildInfoPanel()
}

const ethernetWidget: AtomicWidget = {
    id: "ethernet",
    category: "system",
    barOrder: 70,
    name: t("cc.ethernet.name"),
    icon: Icons.ethernet,
    locations: ["bar", "cc"],
    isAvailable: () => !!AstalNetwork.get_default()?.wired,
    watchAvailable: (cb) => { AstalNetwork.get_default()?.connect("notify::wired", cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 3,
}

export default ethernetWidget
