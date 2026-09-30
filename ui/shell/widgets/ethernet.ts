import Gtk from "gi://Gtk?version=4.0"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, PANEL_W, AtomicWidget, ContentBudget, WidgetSize, makeRoundTile, makeSplitCapsuleTile, panelRow, panelInfoRow, panelSeparator, panelSwitch } from "../common/widget-kit"
import { menuRow } from "../common/MenuRow"
import shellActions from "../core/ShellActions"
import status from "../core/Status"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import * as Net from "../core/NetworkService"

// The adapter is READ on every call, never captured: a USB-Ethernet dongle plugged in
// after a tile was built has to reach it, and `watchWired` re-arms on that hot-plug
// (NetworkService.watchDevices — the bug tech-debt #22/#71 described).
//
// A switch, as GNOME's Wired toggle (owner, 2026-09-28): the tile's badge turns the cable
// on and off, the rest opens the detail — Bluetooth's shape. The bar icon stays a
// presence indicator (there while a cable is connected, #666), so turning the cable off
// is done here or in Settings, never from the icon that then disappears.

const icon = () => uiIcon("nd-network-wired")
const toggle = () => { Net.setWiredEnabled(!Net.wiredEnabled()).catch(e => console.error("[ethernet] switch:", e)) }

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: icon(), pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
}

function buildContent(size: WidgetSize, budget: ContentBudget): Gtk.Widget {
    // No room for a second target at 1×1: the toggle wins, as Bluetooth's does.
    if (size === WidgetSize.SINGLE)
        return makeRoundTile(icon, () => Net.wiredEnabled(), toggle, Net.watchWired)
    return makeSplitCapsuleTile(icon, () => t("cc.ethernet.name"), () => Net.wiredStateText(), toggle, Net.watchWired, budget)
}

/** The switch: the bar panel's title row, the CC detail's title line. */
const buildSwitch = (): Gtk.Widget => panelSwitch(() => Net.wiredEnabled(), (on) => { Net.setWiredEnabled(on).catch(e => console.error("[ethernet] switch:", e)) }, Net.watchWired)

/** ONE panel for the bar and the CC, like Wi-Fi's: the state, the addresses, and the way
 *  to everything else — IP and DNS are set in Settings, where the form has room. */
function buildEthernetPanel(opts: { withSwitch: boolean }): Gtk.Widget {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    if (opts.withSwitch) {
        const switchRow = panelRow(t("cc.ethernet.name"), buildSwitch())
        switchRow.margin_bottom = 4
        switchRow.margin_start = 12
        switchRow.margin_end = 12
        outer.append(switchRow)
        outer.append(panelSeparator())
    }

    const up = () => Net.wiredState() === "connected"
    const live = () => Net.ipLive(Net.wiredIpTarget())
    const rows = [
        panelInfoRow(t("widget.ethernet.row.status"), () => Net.wiredStateText()),
        panelInfoRow("IP", () => (up() && live().v4?.address) || "—"),
        panelInfoRow(t("settings.network.detail.gateway"), () => (up() && live().v4?.gateway) || "—"),
        panelInfoRow(t("widget.ethernet.row.interface"), () => Net.wired()?.device.get_iface() || "—"),
    ]
    const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 8 })
    for (const r of rows) info.append(r.row)
    outer.append(info)

    outer.append(panelSeparator())
    outer.append(menuRow({
        label: t("widget.wifi.settings"),
        onClick: () => {
            status.closeOverlays()
            shellActions.openSettingsPage?.("network")
        },
    }))

    const dispose = Net.watchWired(() => rows.forEach(r => r.update()))
    outer.connect("unrealize", dispose)
    return outer
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    return buildEthernetPanel({ withSwitch: false })
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const panel = buildEthernetPanel({ withSwitch: true })
    panel.width_request = PANEL_W.lg
    return panel
}

const ethernetWidget: AtomicWidget = {
    id: "ethernet",
    category: "system",
    barOrder: 70,
    name: t("cc.ethernet.name"),
    icon: icon(),
    locations: ["bar", "cc"],
    defaultInCc: false,   // off by default — Wi-Fi covers the common case; available to add
    isAvailable: () => !!Net.wired(),
    // A presence indicator (contract.ts `barActive`): there while a cable is connected,
    // nothing to show without one. Off in the bar by default — there is nothing to DO
    // from a wired icon (owner, 2026-09-28: optional).
    defaultInBar: false,
    barActive: () => Net.wiredConnected(),
    watchBarActive: (cb) => Net.watchWired(cb),
    watchAvailable: (cb) => { Net.watchDevices(cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildDetailPanel,
    ccDetailSwitch: buildSwitch,
    ccDetailRows: 4,
    // The accent fill of an on switch, as Bluetooth's.
    getActive: () => Net.wiredEnabled(),
    watchActive: Net.watchWired,
}

export default ethernetWidget
