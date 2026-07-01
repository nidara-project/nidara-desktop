import { Gtk } from "ags/gtk4"
import { buildRoundContent, buildSplitCapsuleContent } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import * as BT from "../core/BluetoothService"

function buildBarContent() {
    return makeIconAction({
        getIcon: () => Icons.bluetooth,
        onAction: () => BT.togglePower(),
        activeClass: "bar-widget-active",
        getActive: () => BT.isPowered(),
    })
}

const getIcon = () => BT.isPowered() ? Icons.bluetooth : Icons.bluetoothOff
const getSub = () => BT.isPowered() ? t("widget.bluetooth.sub.active") : t("widget.bluetooth.sub.inactive")

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE)
        // Every platform (macOS/GNOME/Windows) keeps the toggle live even at the
        // most compact representation — "open detail" is always a SEPARATE
        // affordance (a chevron, a wider row), never a fallback on the same tap
        // target. There's no room for a second hit-region at 1×1, so the detail
        // panel simply isn't reachable from here — only from WIDE/SQUARE below.
        return buildRoundContent(getIcon, () => BT.isPowered(), BT.togglePower, BT.watchPower)

    return buildSplitCapsuleContent(getIcon, () => t("widget.bluetooth.name"), getSub, BT.togglePower, BT.watchPower)
}

// ── CC detail panel: power switch + paired device list (connect/disconnect).
// Pairing/forgetting new devices stays in Settings → Bluetooth — the CC detail
// is for quick glance + reconnecting what's already paired, like wifi's panel. ──

function buildDeviceList(): { box: Gtk.ListBox; refresh: () => void } {
    const listBox = new Gtk.ListBox({ css_classes: ["boxed-list"], selection_mode: Gtk.SelectionMode.NONE })

    const refresh = () => {
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        const devices = BT.pairedDevices() as any[]
        if (devices.length === 0) {
            const empty = new Gtk.Label({
                label: t("settings.bluetooth.no-devices"),
                css_classes: ["nidara-row-subtitle"],
                margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 14,
            })
            const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            row.set_child(empty)
            listBox.append(row)
            return
        }

        devices.forEach(dev => {
            const devImg = new Gtk.Image({ pixel_size: 18, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] })
            if (dev.icon) devImg.icon_name = dev.icon; else devImg.gicon = Icons.bluetooth

            const nameLabel = new Gtk.Label({
                label: BT.deviceName(dev), css_classes: ["nidara-row-title"],
                halign: Gtk.Align.START, hexpand: true, ellipsize: 3, max_width_chars: 16,
            })

            const actionBtn = new Gtk.Button({
                valign: Gtk.Align.CENTER,
                css_classes: dev.connected ? ["destructive-action"] : ["suggested-action"],
                label: dev.connected ? t("settings.bluetooth.disconnect") : t("settings.bluetooth.connect"),
            })
            actionBtn.connect("clicked", () => {
                if (dev.connected) BT.disconnectDevice(dev); else BT.connectDevice(dev)
            })

            const inner = new Gtk.Box({ spacing: 8, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })
            inner.append(devImg); inner.append(nameLabel); inner.append(actionBtn)

            const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            row.set_child(inner)
            listBox.append(row)
        })
    }

    return { box: listBox, refresh }
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = new Gtk.Switch({ active: BT.isPowered(), valign: Gtk.Align.CENTER })
    sw.connect("state-set", (_sw: Gtk.Switch, state: boolean) => { BT.setPowered(state); return false })

    const switchLabel = new Gtk.Label({ label: t("widget.bluetooth.name"), css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true })
    const switchRow = new Gtk.Box({ spacing: 8, margin_bottom: 4 })
    switchRow.append(switchLabel)
    switchRow.append(sw)

    const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 2, margin_bottom: 2 })
    const { box: listBox, refresh } = buildDeviceList()

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    outer.append(switchRow)
    outer.append(sep)
    outer.append(listBox)

    const applyPowered = () => {
        const on = BT.isPowered()
        sw.active = on
        listBox.visible = on
        if (on) refresh()
    }

    const disposeDevices = BT.watchDevices(() => { if (BT.isPowered()) refresh() })
    const disposePower = BT.watchPower(applyPowered)
    outer.connect("unrealize", () => { disposeDevices(); disposePower() })

    applyPowered()
    return outer
}

const btWidget: AtomicWidget = {
    id: "bt",
    category: "system",
    barOrder: 60,
    name: t("widget.bluetooth.name"),
    icon: Icons.bluetooth,
    locations: ["bar", "cc"],
    isAvailable: () => BT.hasAdapter(),
    watchAvailable: (cb) => { BT.watchAdapter(cb) },
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 4,
    getActive: () => BT.isPowered(),
    watchActive: BT.watchPower,
}

export default btWidget
