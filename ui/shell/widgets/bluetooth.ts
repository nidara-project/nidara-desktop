import Gtk from "gi://Gtk?version=4.0"
import { NidaraButton } from "../../lib/nidara-kit/button"
import { AtomicWidget, ContentBudget, WidgetSize, makeRoundTile, makeSplitCapsuleTile, panelRow, panelSeparator, panelSwitch, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import * as BT from "../core/BluetoothService"

const getIcon = () => BT.isPowered() ? uiIcon("nd-bluetooth-active") : uiIcon("nd-bluetooth-disabled")

// The same icon as the Control Centre tile, off included — the pill used to show
// `bluetooth-active` whatever the state. And subscribed: the power flips
// asynchronously, so the sync right after the click still reads the old state.
function buildBarContent() {
    return makeBarIcon({
        getIcon,
        onAction: () => BT.togglePower(),
        activeClass: "bar-widget-active",
        getActive: () => BT.isPowered(),
        subscribe: BT.watchPower,
    })
}
const getSub = () => BT.isPowered() ? t("widget.bluetooth.sub.active") : t("widget.bluetooth.sub.inactive")

function buildContent(size: WidgetSize, budget: ContentBudget): Gtk.Widget {
    if (size === WidgetSize.SINGLE)
        // Every major platform keeps the toggle live even at the
        // most compact representation — "open detail" is always a SEPARATE
        // affordance (a chevron, a wider row), never a fallback on the same tap
        // target. There's no room for a second hit-region at 1×1, so the detail
        // panel simply isn't reachable from here — only from WIDE/SQUARE below.
        return makeRoundTile(getIcon, () => BT.isPowered(), BT.togglePower, BT.watchPower)

    return makeSplitCapsuleTile(getIcon, () => t("widget.bluetooth.name"), getSub, BT.togglePower, BT.watchPower, budget)
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
                margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
            })
            const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            row.set_child(empty)
            listBox.append(row)
            return
        }

        devices.forEach(dev => {
            const devImg = new Gtk.Image({ pixel_size: 18, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] })
            if (dev.icon) devImg.icon_name = dev.icon; else devImg.gicon = uiIcon("nd-bluetooth-active")

            const nameLabel = new Gtk.Label({
                label: BT.deviceName(dev), css_classes: ["nidara-row-title"],
                halign: Gtk.Align.START, hexpand: true, ellipsize: 3, max_width_chars: 16,
            })

            // Same button as the Settings → Bluetooth row (unified 2026-08-02):
            // connect is the affirmative CTA (`primary`), disconnect is REVERSIBLE
            // and therefore neutral — `danger` is for destructive only. It used to
            // be Adwaita's suggested-/destructive-action, which looked native only
            // because this list renders inside `.nidara-detail-panel`, one of the two
            // scopes that restyle those classes; anywhere else it was raw GTK.
            const actionBtn = NidaraButton({
                valign: Gtk.Align.CENTER,
                pill: true,
                variant: dev.connected ? "secondary" : "primary",
                label: dev.connected ? t("settings.bluetooth.disconnect") : t("settings.bluetooth.connect"),
            })
            actionBtn.connect("clicked", () => {
                if (dev.connected) BT.disconnectDevice(dev); else BT.connectDevice(dev)
            })

            const inner = new Gtk.Box({ spacing: 8, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 })
            inner.append(devImg); inner.append(nameLabel); inner.append(actionBtn)

            const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            row.set_child(inner)
            listBox.append(row)
        })
    }

    return { box: listBox, refresh }
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = panelSwitch(() => BT.isPowered(), (on) => BT.setPowered(on), BT.watchPower)

    const switchRow = panelRow(t("widget.bluetooth.name"), sw)
    switchRow.margin_bottom = 4      // air before the separator
    const { box: listBox, refresh } = buildDeviceList()

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    outer.append(switchRow)
    outer.append(panelSeparator())
    outer.append(listBox)

    const applyPowered = () => {
        const on = BT.isPowered()
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
    icon: uiIcon("nd-bluetooth-active"),
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
