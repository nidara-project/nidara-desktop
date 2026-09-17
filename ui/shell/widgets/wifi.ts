import Gtk from "gi://Gtk?version=4.0"
import { AtomicWidget, ContentBudget, WidgetSize, makeIconTile, makeCapsuleTile, panelRow, panelInfoRow, panelSeparator, panelSwitch } from "../common/widget-kit"
import { menuRow } from "../common/MenuRow"
import { joinNetwork, joinOtherNetwork } from "../common/WifiSecretsDialog"
import shellActions from "../core/ShellActions"
import status from "../core/Status"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"

// A form opened from the CC must close it first: an open overlay holds the keyboard grab.
const closeOverlays = () => status.closeOverlays()
import * as Net from "../core/NetworkService"

// The adapter is read through Net.wifi() on every call rather than captured, so a
// dongle plugged in mid-session reaches these; the watchers re-arm themselves on
// that hot-plug (see NetworkService.watchDevices — tech-debt #22/#71).

const LEVEL_ICONS = [uiIcon("nd-network-wireless-signal-none"), uiIcon("nd-network-wireless-signal-weak"), uiIcon("nd-network-wireless-signal-ok"), uiIcon("nd-network-wireless")]

/**
 * The icon for where the adapter stands. Until 2026-09-14 it said only whether the
 * RADIO was on: a laptop that had lost its network, or was sitting at one bar of
 * signal, showed the same full fan as one on a strong connection.
 *   off → crossed out · joining → the sync glyph · on a network → 0–3 arcs by
 *   signal · on but on no network → the full fan, DIMMED by the bar (a tile says
 *   "Not connected" in words instead).
 */
function getIcon() {
    const link = Net.wifiLink()
    switch (link.state) {
        case "off":        return uiIcon("nd-network-wireless-disabled")
        case "connecting": return uiIcon("nd-network-wireless-acquiring")
        case "connected":  return LEVEL_ICONS[Net.signalLevel(link.strength)]
        default:           return uiIcon("nd-network-wireless")
    }
}

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    // watchWifiLink fires on every strength change a scan produces. Both writes are
    // guarded: re-assigning an identical gicon still clears and redraws the image, and
    // in the bar a redraw is a full re-blur — the reason this icon once watched the
    // radio flag ONLY. The level is what changes the glyph, not the raw number.
    const sync = () => {
        const ic = getIcon()
        if (image.gicon !== ic) image.gicon = ic
        const dim = Net.wifiLink().state === "disconnected"
        const opacity = dim ? 0.45 : 1
        if (image.opacity !== opacity) image.opacity = opacity
    }
    sync()
    const dispose = Net.watchWifiLink(sync)
    image.connect("unrealize", dispose)
    return image
}

function buildContent(size: WidgetSize, budget: ContentBudget): Gtk.Widget {
    const getSub = () => {
        const link = Net.wifiLink()
        switch (link.state) {
            case "connected":  return link.ssid
            case "connecting": return link.ssid || t("settings.network.ap.connecting")
            case "disconnected": return t("cc.wifi.sub.disconnected")
            default:           return t("cc.wifi.sub.off")
        }
    }

    // The tile guards its own gicon assignment (see makeIconTile), so the strength
    // churn of watchWifiLink costs a comparison, not a redraw.
    if (size === WidgetSize.SINGLE)
        return makeIconTile(getIcon, Net.watchWifiLink)

    return makeCapsuleTile(getIcon, () => t("cc.wifi.name"), getSub, Net.watchWifiLink, budget)
}

function buildInfoPanel(): Gtk.Widget {
    const ssid  = panelInfoRow(t("widget.wifi.row.network"), () => Net.wifi()?.ssid || "—")
    const state = panelInfoRow(t("widget.wifi.row.status"), () => {
        // "Disabled" means the radio is OFF, which is only sayable when there IS a
        // radio — with no adapter this stays "Disconnected", as it always did.
        const w = Net.wifi()
        if (w && !w.enabled) return t("widget.wifi.row.disabled")
        return w?.ssid ? t("cc.wifi.sub.connected") : t("cc.wifi.sub.disconnected")
    })
    const ip = panelInfoRow("IP", () => Net.getIp(Net.wifi()))

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

// ── CC detail: the radio switch, the networks in range, and the two ways out ──
//
// Joining a network used to mean Settings → Network. Now the list is here, as on every
// desktop that has a quick-settings panel: one row per network (strongest AP of each
// SSID), a tick on the one the adapter is on, a lock on the secured ones. A click joins
// through the SAME path as Settings (common/WifiSecretsDialog.joinNetwork), so a
// password, an enterprise form or a refused key look identical from both.
//
// Clicking the network you are on does nothing — leaving it is the switch or Settings.
// A mis-tap in a list that reorders by signal strength should not drop the connection.

function buildNetworkList(): { box: Gtk.Box; refresh: () => void } {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    /** SSIDs whose last attempt from this panel failed — the one thing NM cannot tell us back. */
    const failed = new Set<string>()

    const refresh = () => {
        let child = box.get_first_child()
        while (child) { box.remove(child); child = box.get_first_child() }

        const networks = Net.visibleNetworks(10)
        if (networks.length === 0) {
            box.append(new Gtk.Label({
                label: t("widget.wifi.no-networks"),
                css_classes: ["nidara-row-subtitle"],
                halign: Gtk.Align.START,
                margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
            }))
            return
        }

        const saved = Net.savedWifiSsids()
        for (const ap of networks) {
            const ssid = Net.apSsid(ap)
            const link = Net.apLinkState(ap)

            const trailing = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER })
            const note = link === "connecting" ? t("settings.network.ap.connecting")
                : link === "idle" && failed.has(ssid) ? t("settings.network.ap.failed")
                : ""
            if (note) trailing.append(new Gtk.Label({ label: note, css_classes: ["nidara-row-subtitle"] }))
            if (Net.isSecured(ap))
                trailing.append(new Gtk.Image({ gicon: uiIcon("nd-system-lock-screen"), pixel_size: 12, opacity: 0.5, css_classes: ["nd-icon"] }))

            box.append(menuRow({
                label: ssid,
                icon: LEVEL_ICONS[Net.signalLevel(ap.strength)],
                ellipsize: true,
                trailing,
                checked: link === "connected",
                onClick: () => {
                    if (link !== "idle") return
                    failed.delete(ssid)
                    joinNetwork(ap, saved.has(ssid), closeOverlays).catch((e: any) => {
                        if (e?.reason !== "cancelled") failed.add(ssid)
                        refresh()
                    })
                },
            }))
        }
    }

    return { box, refresh }
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const sw = panelSwitch(() => Net.wifiEnabled(), (on) => { Net.setWifiEnabled(on) }, Net.watchWifiEnabled)
    const switchRow = panelRow(t("cc.wifi.name"), sw)
    switchRow.margin_bottom = 4      // air before the separator
    // On the same text axis as the rows below: a menu row carries 12px of padding on
    // each side, and a bare panelRow none, so "Wi-Fi" sat 12px left of every SSID.
    switchRow.margin_start = 12
    switchRow.margin_end = 12

    const { box: list, refresh } = buildNetworkList()

    const footer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    footer.append(menuRow({
        label: t("settings.network.ap.other"),
        onClick: () => { joinOtherNetwork(closeOverlays).catch(() => {}) },
    }))
    footer.append(menuRow({
        label: t("widget.wifi.settings"),
        onClick: () => {
            status.cc_open = false
            shellActions.openSettingsPage?.("network")
        },
    }))

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    outer.append(switchRow)
    outer.append(panelSeparator())
    outer.append(list)
    outer.append(panelSeparator())
    outer.append(footer)

    const apply = () => {
        const on = Net.wifiEnabled()
        list.visible = on
        if (on) refresh()
    }
    // The access-point list, the device state and saved profiles — not strength, so a
    // scan does not rebuild rows under the pointer. A scan is asked for on open: NM's
    // own cadence is minutes when connected, and a stale list is the one thing this
    // panel exists to avoid.
    const dispose = Net.watchAccessPoints(apply)
    outer.connect("unrealize", dispose)
    apply()
    Net.rescan()
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
    icon: uiIcon("nd-network-wireless"),
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
    ccDetailRows: 4,
}

export default wifiWidget
