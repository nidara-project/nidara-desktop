import { Gtk } from "ags/gtk4"
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
    return new Gtk.Image({ gicon: Icons.ethernet, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
}

function buildContent(size: WidgetSize): Gtk.Widget {
    // The adapter is READ on every call, never captured: a USB-Ethernet dongle
    // plugged in after this tile was built has to reach it, and `watchWired` fires
    // on that hot-plug (NetworkService.watchDevices). Capturing it here is exactly
    // the bug tech-debt #22/#71 described.
    const isConnected = () => Net.wiredConnected()
    const getSub = () => {
        if (!Net.wired()) return t("cc.ethernet.sub.no-cable")
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

    const dispose = Net.watchWired(inner.update)
    inner.box.connect("unrealize", dispose)
    return wrapCapsuleTile(inner.box)
}

function buildInfoPanel(): Gtk.Widget {
    const iface = infoRow(t("widget.ethernet.row.interface"), () => Net.wired()?.device.get_iface() || "—")
    const state = infoRow(t("widget.ethernet.row.status"),    () => Net.wiredConnected() ? t("cc.ethernet.sub.connected") : t("cc.ethernet.sub.disconnected"))
    const ip    = infoRow("IP",                               () => Net.getIp(Net.wired()))
    const speed = infoRow(t("widget.ethernet.row.speed"),     () => { const s = Net.wired()?.speed; return s ? `${s} Mb/s` : "—" })

    const updateAll = () => { iface.update(); state.update(); ip.update(); speed.update() }
    updateAll()

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, hexpand: true, margin_top: 4 })
    box.append(iface.row)
    box.append(state.row)
    box.append(ip.row)
    box.append(speed.row)

    // One subscription covers link state, IP and negotiated speed — and re-arms
    // itself if the adapter is swapped, so the panel never needs a device of its own.
    const dispose = Net.watchWired(updateAll)
    box.connect("unrealize", dispose)

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
    defaultInCc: false,   // off by default — Wi-Fi covers the common case; available to add
    isAvailable: () => !!Net.wired(),
    watchAvailable: (cb) => { Net.watchDevices(cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 3,
}

export default ethernetWidget
