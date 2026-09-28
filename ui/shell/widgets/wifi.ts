import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import NM from "gi://NM?version=1.0"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, PANEL_W, AtomicWidget, ContentBudget, WidgetSize, makeIconTile, makeCapsuleTile, panelRow, panelInfoRow, panelSeparator, panelSwitch } from "../common/widget-kit"
import { menuRow, menuHeader } from "../common/MenuRow"
import { attachTooltip } from "../../lib/nidara-kit"
import { NidaraButton } from "../../lib/nidara-kit/button"
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
// (That button is no longer a Tab stop at all — see currentRow.)
function disclosure(isOpen: () => boolean, closedIcon: "nd-pan-down" | "nd-pan-end"): { image: Gtk.Image; sync: () => void } {
    const image = new Gtk.Image({ pixel_size: 12, css_classes: ["nd-icon", "wifi-dim"], valign: Gtk.Align.CENTER })
    const sync = () => { image.gicon = uiIcon(isOpen() ? "nd-pan-up" : closedIcon) }
    sync()
    return { image, sync }
}

// ── A network row: fixed columns, so nothing moves from one row to the next ──
//   [badge] name ……… status [lock] [chevron]
// The badge is the network's signal in a circle, filled with the accent on the network
// you are on (that IS the "connected" mark — no tick, Apple's menu has none). The lock
// and chevron columns are reserved on every row, empty or not: the owner's review of
// the first version, 2026-09-28 — "the lock, the arrow and the tick look thrown there".

/** A fixed-width column: `child` or nothing, the width kept either way. */
function slot(child: Gtk.Widget | null): Gtk.Widget {
    const box = new Gtk.Box({ width_request: 12, halign: Gtk.Align.END, valign: Gtk.Align.CENTER, css_classes: ["wifi-slot"] })
    if (child) box.append(child)
    return box
}

/** The badge IS the image: its circle is CSS (min size + background), the glyph centred
 *  by GtkImage itself. No box around it — a child's hexpand propagates up, and a centred
 *  image in a box made the leave button take half the row. */
function badge(icon: Gio.FileIcon, on: boolean): Gtk.Widget {
    return new Gtk.Image({ gicon: icon, pixel_size: 14, css_classes: on ? ["nd-icon", "wifi-badge", "is-on"] : ["nd-icon", "wifi-badge"], valign: Gtk.Align.CENTER })
}
const apBadge = (ap: NM.AccessPoint, on: boolean) => badge(LEVEL_ICONS[Net.signalLevel(ap.strength)], on)

/** Name + status + the two slots — the part of a row right of its badge. */
function rowText(ssid: string, status: string, secured: boolean, chevron: Gtk.Widget | null): Gtk.Box {
    const box = new Gtk.Box({ spacing: 8, hexpand: true })
    box.append(new Gtk.Label({ label: ssid, css_classes: ["nidara-menu-label"], hexpand: true, xalign: 0, ellipsize: 3, max_width_chars: 1 }))
    if (status) box.append(new Gtk.Label({ label: status, css_classes: ["nidara-row-subtitle"] }))
    box.append(slot(secured ? new Gtk.Image({ gicon: uiIcon("nd-system-lock-screen"), pixel_size: 12, css_classes: ["nd-icon", "wifi-dim"] }) : null))
    box.append(slot(chevron))
    return box
}

function buildWifiPanel(opts: { withSwitch: boolean }): Gtk.Widget {
    /** SSIDs whose last attempt from this panel failed — the one thing NM cannot tell us back. */
    const failed = new Set<string>()
    let detailsOpen = false
    let othersOpen = false

    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    // Each focusable row by what it IS, so a rebuild (a scan, the link changing) hands
    // the keyboard focus back to the same row — or to "Other Networks", never to
    // whatever GTK picks next (see disclosure()).
    let keyed = new Map<string, Gtk.Widget>()
    const keep = <W extends Gtk.Widget>(key: string, w: W): W => { keyed.set(key, w); return w }
    const detailValues: { update: () => void }[] = []

    const join = (ap: NM.AccessPoint | null, saved: boolean, profile: NM.RemoteConnection | null = null) => {
        const ssid = ap ? Net.apSsid(ap) : Net.profileSsid(profile)
        failed.delete(ssid)
        const p = profile ? Net.connectAp(null, profile) : joinNetwork(ap!, saved, closeOverlays)
        p.catch((e: any) => {
            if (e?.reason !== "cancelled") failed.add(ssid)
            refresh()
        })
    }

    /** A network you are not on: the whole row joins it. */
    const networkRow = (ap: NM.AccessPoint, saved: boolean): Gtk.Widget => {
        const ssid = Net.apSsid(ap)
        const line = new Gtk.Box({ spacing: 10 })
        line.append(apBadge(ap, false))
        line.append(rowText(ssid, failed.has(ssid) ? t("settings.network.ap.failed") : "", Net.isSecured(ap), null))
        const btn = new Gtk.Button({ child: line, css_classes: ["wifi-net"], hexpand: true })
        btn.connect("clicked", () => join(ap, saved))
        return keep(`net:${ssid}`, btn)
    }

    /** A saved HIDDEN network: it announces no name, so it cannot be in the scan — it is
     *  listed from its profile and joined by it (what libnma's "Connection" menu was for). */
    const hiddenRow = (profile: NM.RemoteConnection): Gtk.Widget => {
        const ssid = Net.profileSsid(profile)
        const line = new Gtk.Box({ spacing: 10 })
        line.append(badge(uiIcon("nd-network-wireless"), false))
        line.append(rowText(ssid, failed.has(ssid) ? t("settings.network.ap.failed") : "", Net.profileSecured(profile), null))
        const btn = new Gtk.Button({ child: line, css_classes: ["wifi-net"], hexpand: true })
        btn.connect("clicked", () => join(null, true, profile))
        return keep(`hidden:${ssid}`, btn)
    }

    /** The network the adapter is on or joining. ONE row to the eye (the hover is the
     *  row's), two targets: the badge leaves the network, as Apple's icon does; the rest
     *  opens the details — Apple's Option-click, behind a visible chevron here (owner). */
    const currentRow = (ap: NM.AccessPoint, link: "connected" | "connecting"): Gtk.Widget => {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
        // 6, not 10: the main button carries 4px of its own on the left, so its focus
        // ring clears the name — the name stays on the 46px axis of every other row.
        const line = new Gtk.Box({ spacing: 6, css_classes: ["wifi-net", "is-current"] })

        // Not a Tab stop: opened by keyboard, a detail focuses its first stop, and Enter
        // there would have disconnected on arrival (measured 2026-09-28). The pointer gets
        // Apple's badge; the keyboard gets "Disconnect" inside the details.
        const leave = new Gtk.Button({ child: apBadge(ap, link === "connected"), css_classes: ["wifi-leave"], valign: Gtk.Align.CENTER, focusable: false })
        attachTooltip(leave, t("settings.network.ap.disconnect"))
        leave.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.network.ap.disconnect")])
        leave.connect("clicked", () => { Net.disconnectWifi().catch(() => {}) })
        line.append(leave)

        const arrow = disclosure(() => detailsOpen, "nd-pan-down")
        const text = rowText(Net.apSsid(ap), link === "connecting" ? t("settings.network.ap.connecting") : "",
            Net.isSecured(ap), link === "connected" ? arrow.image : null)
        let details: Gtk.Widget | null = null
        const main = new Gtk.Button({ child: text, css_classes: ["wifi-current-main"], hexpand: true, sensitive: link === "connected" })
        main.update_property([Gtk.AccessibleProperty.DESCRIPTION], [t("settings.network.ap.details")])
        main.connect("clicked", () => {
            detailsOpen = !detailsOpen
            arrow.sync()
            if (details) details.visible = detailsOpen
        })
        line.append(keep("current", main))
        box.append(line)

        if (link === "connected") {
            const d = () => Net.wifiConnectionDetails()
            const rows = [
                panelInfoRow("IP", () => d()?.ip ?? "—"),
                panelInfoRow(t("settings.network.detail.gateway"), () => d()?.gateway ?? "—"),
                panelInfoRow(t("settings.network.detail.band"), () => d()?.band ?? "—"),
                panelInfoRow(t("settings.network.detail.channel"), () => { const x = d(); return x ? String(x.channel) : "—" }),
                panelInfoRow(t("settings.network.detail.security"), () => d()?.security ?? "—"),
            ]
            const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ["wifi-details"], visible: detailsOpen })
            for (const r of rows) { panel.append(r.row); detailValues.push(r) }
            const disconnect = NidaraButton({ label: t("settings.network.ap.disconnect"), variant: "secondary", pill: true, halign: Gtk.Align.END })
            disconnect.margin_top = 4
            disconnect.connect("clicked", () => { Net.disconnectWifi().catch(() => {}) })
            panel.append(keep("disconnect", disconnect))
            box.append(panel)
            details = panel
        }
        return box
    }

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
        const hidden = Net.savedHiddenNetworks().slice(0, MAX_KNOWN)

        if (current) body.append(currentRow(current, Net.apLinkState(current) as "connected" | "connecting"))
        if (known.length + hidden.length > 0) {
            body.append(menuHeader(t("widget.wifi.known")))
            for (const ap of known) body.append(networkRow(ap, true))
            for (const p of hidden) body.append(hiddenRow(p))
        }
        if (!current && known.length + hidden.length + others.length === 0) {
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
        othersBox.append(keep("hidden-new", menuRow({
            label: t("settings.network.ap.other"),
            onClick: () => { joinOtherNetwork(closeOverlays).catch(() => {}) },
        })))
        body.append(othersBox)
    }

    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
    // In the bar the switch row IS the panel's title. The CC puts the same switch on its
    // detail's title line instead (ccDetailSwitch), so it is not here twice.
    let bodySep: Gtk.Widget | null = null
    if (opts.withSwitch) {
        const switchRow = panelRow(t("cc.wifi.name"), buildRadioSwitch())
        switchRow.margin_bottom = 4      // air before the separator
        // On the text axis of the section rows below (a menu row's 12px padding).
        switchRow.margin_start = 12
        switchRow.margin_end = 12
        outer.append(switchRow)
        bodySep = panelSeparator()
        outer.append(bodySep)
    }
    outer.append(body)
    const footSep = panelSeparator()
    outer.append(footSep)
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
        if (bodySep) bodySep.visible = on
        footSep.visible = on || opts.withSwitch
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

/** The radio switch: the bar panel's title row, the CC detail's title line. */
const buildRadioSwitch = (): Gtk.Widget => panelSwitch(() => Net.wifiEnabled(), (on) => { Net.setWifiEnabled(on) }, Net.watchWifiEnabled)

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    return buildWifiPanel({ withSwitch: false })
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const panel = buildWifiPanel({ withSwitch: true })
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
    ccDetailSwitch: buildRadioSwitch,
    ccDetailRows: 6,
}

export default wifiWidget
