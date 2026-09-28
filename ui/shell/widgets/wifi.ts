import Gtk from "gi://Gtk?version=4.0"
import NM from "gi://NM?version=1.0"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, PANEL_W, AtomicWidget, ContentBudget, WidgetSize, makeIconTile, makeCapsuleTile, panelRow, panelInfoRow, panelSeparator, panelSwitch } from "../common/widget-kit"
import { menuRow, menuHeader } from "../common/MenuRow"
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
    const image = new Gtk.Image({ gicon: getIcon(), pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
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

// ── The Wi-Fi panel: ONE, for the bar and the CC ──────────────────────────────
//
// Apple's Wi-Fi status menu, read in its user guide (owner's reference, 2026-09-28):
// the menu bar and Control Center open the SAME menu — the radio, the network you are
// on, Known Networks, Other Networks folded with "Other…" at its end for a hidden one.
// Clicking a network joins it; clicking the Wi-Fi ICON left of the connected network
// leaves it (the icon, not the row: a mis-tap in a list that reorders by strength must
// not drop the connection). Its details — IP, router, band, security — are Apple's
// Option-click, a gesture nothing on screen announces; here they sit behind a visible
// chevron on that row instead (owner). Until then the bar showed three read-only lines.
//
// Joining goes through the SAME path as Settings (common/WifiSecretsDialog.joinNetwork),
// so a password, an enterprise form or a refused key look identical from everywhere.
// Forgetting a network stays in Settings, as in Apple's.

const MAX_KNOWN = 5
const MAX_OTHERS = 8

// A disclosure: flipping it shows/hides what it opens IN PLACE — never a rebuild. A
// rebuild destroys the focused row, and GTK then moved the keyboard focus to the
// current network's leave button (measured driving it by keyboard, 2026-09-28): Enter
// opened the details, and the next Enter — meant to close them — would disconnect.
function disclosure(isOpen: () => boolean, closedIcon: "nd-pan-down" | "nd-pan-end"): { image: Gtk.Image; sync: () => void } {
    const image = new Gtk.Image({ pixel_size: 12, opacity: 0.6, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER })
    const sync = () => { image.gicon = uiIcon(isOpen() ? "nd-pan-up" : closedIcon) }
    sync()
    return { image, sync }
}

function lockIcon(): Gtk.Image {
    return new Gtk.Image({ gicon: uiIcon("nd-system-lock-screen"), pixel_size: 12, opacity: 0.5, css_classes: ["nd-icon"] })
}

function buildWifiPanel(): Gtk.Widget {
    /** SSIDs whose last attempt from this panel failed — the one thing NM cannot tell us back. */
    const failed = new Set<string>()
    let detailsOpen = false
    let othersOpen = false

    const join = (ap: NM.AccessPoint, saved: boolean) => {
        const ssid = Net.apSsid(ap)
        failed.delete(ssid)
        joinNetwork(ap, saved, closeOverlays).catch((e: any) => {
            if (e?.reason !== "cancelled") failed.add(ssid)
            refresh()
        })
    }

    const networkRow = (ap: NM.AccessPoint, saved: boolean): Gtk.Widget => {
        const ssid = Net.apSsid(ap)
        const trailing = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER })
        if (failed.has(ssid))
            trailing.append(new Gtk.Label({ label: t("settings.network.ap.failed"), css_classes: ["nidara-row-subtitle"] }))
        if (Net.isSecured(ap)) trailing.append(lockIcon())
        return keep(`net:${ssid}`, menuRow({
            label: ssid, icon: LEVEL_ICONS[Net.signalLevel(ap.strength)], ellipsize: true, trailing,
            onClick: () => join(ap, saved),
        }))
    }

    // The network the adapter is on or joining: its icon leaves it, the rest of the
    // row opens its details.
    const detailValues: { update: () => void }[] = []
    const currentRow = (ap: NM.AccessPoint, link: "connected" | "connecting"): Gtk.Widget => {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
        const line = new Gtk.Box({ hexpand: true })

        const leave = new Gtk.Button({
            child: new Gtk.Image({ gicon: LEVEL_ICONS[Net.signalLevel(ap.strength)], pixel_size: 15, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER }),
            css_classes: ["nidara-menu-row", "wifi-leave"],
            tooltip_text: t("settings.network.ap.disconnect"),
        })
        leave.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.network.ap.disconnect")])
        leave.connect("clicked", () => { Net.disconnectWifi().catch(() => {}) })
        line.append(keep("leave", leave))

        const trailing = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER })
        if (link === "connecting")
            trailing.append(new Gtk.Label({ label: t("settings.network.ap.connecting"), css_classes: ["nidara-row-subtitle"] }))
        if (Net.isSecured(ap)) trailing.append(lockIcon())
        const arrow = disclosure(() => detailsOpen, "nd-pan-down")
        if (link === "connected") trailing.append(arrow.image)
        let details: Gtk.Widget | null = null
        const main = menuRow({
            label: Net.apSsid(ap), ellipsize: true, trailing, checked: link === "connected",
            sensitive: link === "connected",
            onClick: () => {
                detailsOpen = !detailsOpen
                arrow.sync()
                if (details) details.visible = detailsOpen
            },
        })
        main.add_css_class("wifi-current")
        keep("current", main)
        if (link === "connected")
            main.update_property([Gtk.AccessibleProperty.DESCRIPTION], [t("settings.network.ap.details")])
        line.append(main)
        box.append(line)

        if (link === "connected") {
            const d = () => Net.wifiConnectionDetails()
            const rows = [
                panelInfoRow("IP", () => d()?.ip ?? "—"),
                panelInfoRow(t("settings.network.detail.gateway"), () => d()?.gateway ?? "—"),
                panelInfoRow(t("settings.network.detail.band"), () => {
                    const x = d(); return x ? `${x.band} · ${t("settings.network.detail.channel")} ${x.channel}` : "—"
                }),
                panelInfoRow(t("settings.network.detail.security"), () => d()?.security ?? "—"),
            ]
            const box2 = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ["wifi-details"], visible: detailsOpen })
            for (const r of rows) { box2.append(r.row); detailValues.push(r) }
            box.append(box2)
            details = box2
        }
        return box
    }

    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    // Each focusable row by what it IS, so a rebuild (a scan, the link changing) hands
    // the keyboard focus back to the same row — or to "Other Networks", never to
    // whatever GTK picks next, which could be the leave button (see disclosure()).
    let keyed = new Map<string, Gtk.Widget>()
    const keep = <W extends Gtk.Widget>(key: string, w: W): W => { keyed.set(key, w); return w }

    const refresh = () => {
        const focus = (body.get_root() as Gtk.Window | null)?.get_focus?.() ?? null
        let focusKey: string | null = null
        for (const [k, w] of keyed) if (focus && (focus === w || focus.is_ancestor(w))) focusKey = k
        keyed = new Map()
        detailValues.length = 0
        let child = body.get_first_child()
        while (child) { body.remove(child); child = body.get_first_child() }
        rebuild()
        if (focusKey !== null) (keyed.get(focusKey) ?? keyed.get("others"))?.grab_focus()
    }

    const rebuild = () => {
        const saved = Net.savedWifiSsids()
        const networks = Net.visibleNetworks(MAX_KNOWN + MAX_OTHERS + 1)
        const current = networks.find(ap => Net.apLinkState(ap) !== "idle") ?? null
        const rest = networks.filter(ap => ap !== current)
        const known = rest.filter(ap => saved.has(Net.apSsid(ap))).slice(0, MAX_KNOWN)
        const others = rest.filter(ap => !saved.has(Net.apSsid(ap))).slice(0, MAX_OTHERS)

        if (current) body.append(currentRow(current, Net.apLinkState(current) as "connected" | "connecting"))
        if (known.length > 0) {
            body.append(menuHeader(t("widget.wifi.known")))
            for (const ap of known) body.append(networkRow(ap, true))
        }
        if (!current && known.length === 0 && others.length === 0) {
            body.append(new Gtk.Label({
                label: t("widget.wifi.no-networks"), css_classes: ["nidara-row-subtitle"],
                halign: Gtk.Align.START, margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
            }))
        }
        // Other Networks: folded, as Apple's; "Other network…" (a hidden SSID) at its end.
        const othersBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, visible: othersOpen })
        const arrow = disclosure(() => othersOpen, "nd-pan-end")
        body.append(keep("others", menuRow({
            label: t("widget.wifi.others"), trailing: arrow.image,
            onClick: () => { othersOpen = !othersOpen; arrow.sync(); othersBox.visible = othersOpen },
        })))
        for (const ap of others) othersBox.append(networkRow(ap, false))
        othersBox.append(keep("hidden", menuRow({
            label: t("settings.network.ap.other"),
            onClick: () => { joinOtherNetwork(closeOverlays).catch(() => {}) },
        })))
        body.append(othersBox)
    }

    const sw = panelSwitch(() => Net.wifiEnabled(), (on) => { Net.setWifiEnabled(on) }, Net.watchWifiEnabled)
    const switchRow = panelRow(t("cc.wifi.name"), sw)
    switchRow.margin_bottom = 4      // air before the separator
    // On the same text axis as the rows below: a menu row carries 12px of padding on
    // each side, and a bare panelRow none, so "Wi-Fi" sat 12px left of every SSID.
    switchRow.margin_start = 12
    switchRow.margin_end = 12

    const bodySep = panelSeparator()
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    outer.append(switchRow)
    outer.append(bodySep)
    outer.append(body)
    outer.append(panelSeparator())
    outer.append(menuRow({
        label: t("widget.wifi.settings"),
        onClick: () => {
            status.closeOverlays()
            shellActions.openSettingsPage?.("network")
        },
    }))

    const apply = () => {
        const on = Net.wifiEnabled()
        body.visible = on
        bodySep.visible = on
        if (on) refresh()
    }
    // The access-point list, the device state and saved profiles rebuild the rows — not
    // strength, so a scan does not rebuild them under the pointer. The details take the
    // wider watch: the IP lands with DHCP, after the SSID. A scan is asked for on open:
    // NM's own cadence is minutes when connected.
    const disposeAps = Net.watchAccessPoints(apply)
    const disposeIp = Net.watchWifi(() => detailValues.forEach(r => r.update()))
    outer.connect("unrealize", () => { disposeAps(); disposeIp() })
    apply()
    Net.rescan()
    return outer
}

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    return buildWifiPanel()
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const panel = buildWifiPanel()
    panel.width_request = PANEL_W.xl
    return panel
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
    // A plain on/off control: shown or not, and the icon says radio off (contract.ts
    // `barActive`). A machine without Wi-Fi never shows it — it is not available.
    ccFixed: true,
    watchAvailable: (cb) => { Net.watchDevices(cb) },
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 6,
}

export default wifiWidget
