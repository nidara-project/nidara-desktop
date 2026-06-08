import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { listGroup, createRow, staticLabel, pageBox, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import * as Net from "../../../core/NetworkService"
import type { VpnProfile } from "../../../core/NetworkService"
import { CrystalButton } from "../../../../lib/crystal-ui"

function buildVpnRow(profile: VpnProfile, onRefresh: () => void): Gtk.ListBoxRow {
    let active = profile.active

    const btn = CrystalButton({ pill: true })

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.vpn.btn.connect")
                btn.add_css_class("crystal-btn--primary")
                btn.sensitive = true; break
            case "disconnect":
                // Disconnect is reversible → neutral (secondary). Danger is reserved
                // for destructive actions (forget). See CrystalButton convention.
                btn.label = t("settings.network.vpn.btn.disconnect")
                btn.remove_css_class("crystal-btn--primary")
                btn.sensitive = true; break
            case "loading":
                btn.label = t("settings.network.vpn.btn.connecting")
                btn.sensitive = false; break
            case "error":
                btn.label = t("settings.network.ap.label.error")
                btn.sensitive = false
                setTimeout(() => setState(active ? "disconnect" : "connect"), 2000); break
        }
    }
    setState(active ? "disconnect" : "connect")

    btn.connect("clicked", async () => {
        setState("loading")
        try {
            if (active) {
                await Net.vpnDown(profile.name)
                active = false
            } else {
                await Net.vpnUp(profile.name)
                active = true
            }
            setState(active ? "disconnect" : "connect")
            setTimeout(onRefresh, 1500)
        } catch (e) {
            console.error("[Network] VPN toggle failed:", e)
            setState("error")
        }
    })

    return createRow(profile.name, Net.vpnTypeName(profile.type), btn)
}

// IP with the Settings-style "None" fallback (the CC/bar widgets use a dash).
const ipOf = (service: any) => Net.getIp(service, t("settings.network.label.none"))

// ── AP row ────────────────────────────────────────────────────────────────────

function buildApRow(ap: any, iface: string, isActive: boolean, isSaved: boolean, onRefresh: () => void, onDetails?: () => void): Gtk.ListBoxRow {
    const ssid    = ap.ssid as string
    const secured = Net.isSecured(ap)
    // AstalNetwork.AccessPoint has no `active` property — the active AP is derived
    // by the caller from network.wifi.active_access_point.bssid.
    let active    = isActive

    // Right-side widget: optional info + lock icon + (forget) + action button
    const rightBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })

    // Network details subpage (security, band, channel, BSSID, IP when connected).
    if (onDetails) {
        const infoBtn = CrystalButton({ variant: "ghost", pill: true, tooltip_text: t("settings.network.ap.details") })
        infoBtn.set_child(new Gtk.Image({ gicon: Icons.wifiCog, pixel_size: 16, css_classes: ["cs-icon"] }))
        infoBtn.connect("clicked", onDetails)
        rightBox.append(infoBtn)
    }

    if (secured) {
        rightBox.append(new Gtk.Image({
            gicon: Icons.lock,
            pixel_size: 14,
            opacity: 0.5,
            valign: Gtk.Align.CENTER,
            css_classes: ["cs-icon"],
        }))
    }

    // Forget — only for saved, currently-disconnected networks (you disconnect
    // first, then forget). The row is rebuilt on connect/disconnect so this tracks.
    if (isSaved && !active) {
        const forgetBtn = CrystalButton({
            variant: "danger",
            pill: true,
            tooltip_text: t("settings.network.ap.forget"),
        })
        forgetBtn.set_child(new Gtk.Image({ gicon: Icons.trash, pixel_size: 16, css_classes: ["cs-icon"] }))
        forgetBtn.connect("clicked", async () => {
            forgetBtn.sensitive = false
            try { await Net.forgetProfile(ssid) }
            catch (e) { console.error("[Network] forget failed:", e); forgetBtn.sensitive = true }
            setTimeout(onRefresh, 800)
        })
        rightBox.append(forgetBtn)
    }

    const btn = CrystalButton({ pill: true })
    rightBox.append(btn)

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.ap.connect")
                btn.add_css_class("crystal-btn--primary")
                btn.sensitive = true
                break
            case "disconnect":
                // Reversible → neutral (secondary); danger is reserved for forget.
                btn.label = t("settings.network.ap.disconnect")
                btn.remove_css_class("crystal-btn--primary")
                btn.sensitive = true
                break
            case "loading":
                btn.label = t("settings.network.ap.connecting")
                btn.sensitive = false
                break
            case "error":
                btn.label = t("settings.network.ap.label.error")
                btn.sensitive = false
                setTimeout(() => setState(active ? "disconnect" : "connect"), 2000)
                break
        }
    }

    setState(active ? "disconnect" : "connect")

    // Password popover — created lazily, only for secured new networks
    let pwdPopover: Gtk.Popover | null = null
    let pwdEntry: Gtk.PasswordEntry | null = null

    function getOrBuildPopover(): Gtk.Popover {
        if (pwdPopover) return pwdPopover

        pwdEntry = new Gtk.PasswordEntry({
            placeholder_text: t("settings.network.ap.password-placeholder"),
            show_peek_icon: true,
            hexpand: true,
        })

        const confirmBtn = CrystalButton({
            label: t("settings.network.ap.connect"),
            variant: "primary",
            pill: true,
        })
        confirmBtn.hexpand = true

        const titleLabel = new Gtk.Label({
            label: `${t("settings.network.ap.password-for")} ${ssid}`,
            css_classes: ["crystal-row-title"],
            halign: Gtk.Align.START,
            ellipsize: 3, // PANGO_ELLIPSIZE_END
            max_width_chars: 26,
        })

        const popBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 14, margin_bottom: 14,
            margin_start: 16, margin_end: 16,
            width_request: 260,
        })
        popBox.append(titleLabel)
        popBox.append(pwdEntry)
        popBox.append(confirmBtn)

        pwdPopover = new Gtk.Popover({ autohide: true })
        pwdPopover.set_child(popBox)
        pwdPopover.set_parent(btn)
        btn.connect("unrealize", () => { try { pwdPopover?.unparent() } catch {} })

        const submit = () => {
            const pwd = pwdEntry!.text.trim()
            if (!pwd) return
            pwdPopover!.popdown()
            performConnect(pwd, true)
        }
        confirmBtn.connect("clicked", submit)
        pwdEntry.connect("activate", submit)

        return pwdPopover
    }

    async function performConnect(password?: string, freshProfile = false) {
        setState("loading")
        try {
            await Net.connectAp(ssid, password)
            active = true
            setState("disconnect")
            setTimeout(onRefresh, 2000)
        } catch (e) {
            console.error("[Network] connect failed:", e)
            // A wrong password still leaves a broken saved profile behind; the next
            // attempt would silently reuse it and fail forever. Drop the just-created
            // profile so the password prompt reappears.
            if (freshProfile) { try { await Net.forgetProfile(ssid) } catch {} }
            setState("error")
        }
    }

    btn.connect("clicked", async () => {
        if (active) {
            setState("loading")
            try {
                await Net.disconnectIface(iface)
                active = false
                setState("connect")
                setTimeout(onRefresh, 1000)
            } catch (e) {
                console.error("[Network] disconnect failed:", e)
                setState("disconnect")
            }
            return
        }

        if (!secured || isSaved) {
            performConnect()
        } else {
            const pop = getOrBuildPopover()
            if (pwdEntry) pwdEntry.text = ""
            pop.popup()
        }
    })

    const subtitle = `${ap.strength}% • ${ap.frequency} MHz`
    return createRow(ssid, subtitle, rightBox)
}

// ── AP detail subpage ───────────────────────────────────────────────────────────

function buildApDetailPage(ap: any, network: any): Gtk.Widget {
    // Title (the SSID) rides in the window-header breadcrumb — see the pushSubpage
    // call in refreshAps — so the page body starts straight at the info group.
    const page = pageBox("network-ap-detail-page")

    const { box: infoBox, listBox: infoList } = listGroup(t("settings.network.detail.group.info"))
    const signalLabel = staticLabel(`${ap.strength}%`)
    infoList.append(createRow(t("settings.network.detail.security"),  t("settings.network.detail.security.desc"),  staticLabel(Net.securityLabel(ap))))
    infoList.append(createRow(t("settings.network.detail.signal"),    t("settings.network.detail.signal.desc"),    signalLabel))
    infoList.append(createRow(t("settings.network.detail.band"),      t("settings.network.detail.band.desc"),      staticLabel(Net.freqBand(ap.frequency))))
    infoList.append(createRow(t("settings.network.detail.channel"),   t("settings.network.detail.channel.desc"),   staticLabel(String(Net.freqChannel(ap.frequency)))))
    infoList.append(createRow(t("settings.network.detail.frequency"), t("settings.network.detail.frequency.desc"), staticLabel(`${ap.frequency} MHz`)))
    infoList.append(createRow(t("settings.network.detail.bssid"),     t("settings.network.detail.bssid.desc"),     staticLabel(ap.bssid)))
    const maxRate = ap.max_bitrate ? `${Math.round(ap.max_bitrate / 1000)} Mbps` : "---"
    infoList.append(createRow(t("settings.network.detail.max-rate"),  t("settings.network.detail.max-rate.desc"),  staticLabel(maxRate)))
    page.append(infoBox)

    // IPv4 details — only meaningful while this AP is the active connection, and the
    // values arrive after DHCP. Build the group once and live-update it (visible only
    // while active) instead of snapshotting at open time. A hidden Box child takes no
    // space, so there's no phantom gap when this AP isn't the active one.
    const { box: connBox, listBox: connList } = listGroup(t("settings.network.detail.group.ipv4"))
    const ipLabel    = staticLabel("---")
    const gwLabel    = staticLabel("---")
    const dnsLabel   = staticLabel("---")
    const macLabel   = staticLabel("---")
    const speedLabel = staticLabel("---")
    connList.append(createRow(t("settings.network.ipv4"),           t("settings.network.detail.ipv4.desc"),    ipLabel))
    connList.append(createRow(t("settings.network.detail.gateway"), t("settings.network.detail.gateway.desc"), gwLabel))
    connList.append(createRow(t("settings.network.detail.dns"),     t("settings.network.detail.dns.desc"),     dnsLabel))
    connList.append(createRow(t("settings.network.detail.mac"),     t("settings.network.detail.mac.desc"),     macLabel))
    connList.append(createRow(t("settings.network.speed"),          t("settings.network.detail.speed.desc"),   speedLabel))
    page.append(connBox)

    const isActive = () => {
        const b = network.wifi?.active_access_point?.bssid
        return !!b && b === ap.bssid
    }

    const update = () => {
        signalLabel.label = `${ap.strength}%`
        const active = isActive()
        connBox.visible = active
        if (!active) return

        const dev = network.wifi?.device as any
        let ip = "---", gw = "---", dns = "---", mac = "---", speed = "---"
        try {
            const cfg   = dev?.get_ip4_config?.()
            const addrs = cfg?.get_addresses?.()
            if (addrs?.length > 0) ip = `${addrs[0].get_address()}/${addrs[0].get_prefix()}`
            gw = cfg?.get_gateway?.() || "---"
            const ns = cfg?.get_nameservers?.()
            if (ns?.length > 0) dns = ns.join(", ")
        } catch {}
        try { mac = dev?.hw_address || dev?.get_hw_address?.() || "---" } catch {}
        try { const kbps = dev?.bitrate || 0; if (kbps > 0) speed = `${Math.round(kbps / 1000)} Mbps` } catch {}

        ipLabel.label = ip; gwLabel.label = gw; dnsLabel.label = dns
        macLabel.label = mac; speedLabel.label = speed
    }

    // The signal lives on the AP object itself; IP/speed/active-state live on the
    // wifi + device (covered by watchWifi). Both refresh the page in place.
    const apStrengthId = ap.connect?.("notify::strength", update) ?? 0
    const disposeWifi  = Net.watchWifi(update)
    page.connect("unrealize", () => {
        try { if (apStrengthId) ap.disconnect(apStrengthId) } catch {}
        disposeWifi()
    })
    update()

    return page
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NetworkPage(nav?: SettingsNav) {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: t("settings.network.error.no-service") })

    const page = pageBox("network-page")

    // ── Ethernet ──────────────────────────────────────────────────────────────
    if (network.wired) {
        const { box, listBox } = listGroup(t("settings.network.group.ethernet"))

        const wiredStatusText = () => Net.wiredConnected(network.wired)
            ? t("settings.network.status.connected")
            : t("settings.network.status.disconnected")
        const wiredStatus    = staticLabel(wiredStatusText())
        const interfaceLabel = staticLabel(network.wired.device?.interface || "---")
        const ipLabel        = staticLabel(ipOf(network.wired))

        const updateWired = () => {
            wiredStatus.label    = wiredStatusText()
            interfaceLabel.label = String(network.wired.device?.interface || "---")
            ipLabel.label        = ipOf(network.wired)
        }
        Net.watchWired(updateWired)

        listBox.append(createRow(t("settings.network.ethernet"),  t("settings.network.hw-status.desc"),    wiredStatus))
        listBox.append(createRow(t("settings.network.interface"),           t("settings.network.kernel-device.desc"),     interfaceLabel))
        listBox.append(createRow(t("settings.network.ipv4"),     t("settings.network.ip.desc"),     ipLabel))
        page.append(box)
    }

    // ── Wi-Fi ─────────────────────────────────────────────────────────────────
    if (network.wifi && network.wifi.device) {
        const { box: wifiBox, listBox: wifiList } = listGroup(t("settings.network.group.wi-fi"))

        const wifiSwitch = new Gtk.Switch({ active: Net.wifiEnabled(network.wifi), valign: Gtk.Align.CENTER })
        // state-set issues the radio command; the switch's visible state is driven
        // back from notify::enabled so it stays truthful if the radio is toggled
        // elsewhere (CC tile, nmcli) and doesn't fight the command.
        wifiSwitch.connect("state-set", (_sw, state) => { Net.setWifiEnabled(state); return false })
        network.wifi.connect("notify::enabled", () => { wifiSwitch.active = Net.wifiEnabled(network.wifi) })
        wifiList.append(createRow(t("settings.network.enable-wifi"), t("settings.network.enable-wifi.desc"), wifiSwitch))

        const ssidLabel      = staticLabel("---")
        const ipLabel        = staticLabel("---")
        const speedLabel     = staticLabel("---")
        const ifaceLabel     = staticLabel(String(network.wifi.device?.interface || "---"))

        const updateWifi = () => {
            if (!network.wifi) return
            ssidLabel.label  = String(network.wifi.ssid || t("settings.network.status.disconnected-hw"))
            ipLabel.label    = ipOf(network.wifi)
            // Link speed: AstalNetwork exposes none — read the NM device's bitrate (kb/s).
            const kbps       = (network.wifi.device as any)?.bitrate || 0
            speedLabel.label = kbps > 0 ? `${Math.round(kbps / 1000)} Mbps` : "---"
        }
        // watchWifi also wires the NM device's ip4-config / bitrate / state — WiFi
        // has no `ip4-address` property and notify::ssid fires before DHCP assigns
        // an address, so the device signals are what actually carry IP/speed.
        Net.watchWifi(updateWifi)
        updateWifi()

        wifiList.append(createRow(t("settings.network.interface"),      t("settings.network.wireless-interface.desc"),          ifaceLabel))
        wifiList.append(createRow(t("settings.network.access-point"), t("settings.network.connected-network.desc"),              ssidLabel))
        wifiList.append(createRow(t("settings.network.ip"),  t("settings.network.access-point.desc"),   ipLabel))
        wifiList.append(createRow(t("settings.network.speed"),     t("settings.network.speed.desc"),                speedLabel))
        page.append(wifiBox)

        // ── AP list ───────────────────────────────────────────────────────────
        const iface = String(network.wifi.device?.interface || "")
        const { box: apBox, listBox: apList } = listGroup(t("settings.network.group.access-points"))

        const scanBtn = CrystalButton({
            label: t("settings.network.ap.scan"),
            variant: "secondary",
            pill: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        })

        const headerBox = new Gtk.Box({ spacing: 0, hexpand: true })
        const groupTitleLabel = new Gtk.Label({
            label: t("settings.network.group.access-points").toUpperCase(),
            css_classes: ["crystal-list-title"],
            halign: Gtk.Align.START,
            hexpand: true,
            margin_start: 10,
        })
        headerBox.append(groupTitleLabel)
        headerBox.append(scanBtn)

        // Replace the plain title in apBox with the header+scan button row
        const firstChild = apBox.get_first_child()
        if (firstChild) apBox.remove(firstChild)
        apBox.prepend(headerBox)

        // Bumped on every refresh; the async saved-profiles fetch below bails if a
        // newer refresh superseded it, so overlapping scan bursts can't duplicate rows.
        let refreshGen = 0
        async function refreshAps() {
            if (!network.wifi) return
            const gen = ++refreshGen

            const enabled    = network.wifi.enabled
            const activeAp   = network.wifi.active_access_point
            const activeBssid = activeAp?.bssid

            const aps: any[] = (network.wifi.get_access_points() || [])
                .filter((ap: any) => !!ap.ssid)
                .sort((a: any, b: any) => b.strength - a.strength)
                .slice(0, 12)

            // The connected AP must always be shown, even if it fell outside top-12.
            if (activeAp && activeBssid && !aps.some((ap: any) => ap.bssid === activeBssid)) {
                aps.unshift(activeAp)
            }

            const savedSsids = await Net.listSavedWifiSsids()
            if (gen !== refreshGen) return   // a newer refresh already ran

            let child = apList.get_first_child()
            while (child) { apList.remove(child); child = apList.get_first_child() }

            for (const ap of aps) {
                const onDetails = nav
                    ? () => nav.pushSubpage({
                        id: `network/ap/${ap.bssid}`,
                        title: ap.ssid,
                        parentId: "network",
                        build: () => buildApDetailPage(ap, network),
                    })
                    : undefined
                apList.append(buildApRow(
                    ap, iface,
                    !!activeBssid && ap.bssid === activeBssid,
                    savedSsids.has(ap.ssid),
                    refreshAps,
                    onDetails,
                ))
            }

            // The Scan button lives in this group's header, so the group must stay
            // visible whenever Wi-Fi is on — otherwise there's no way to scan for
            // the first network. Show an empty placeholder when nothing is found.
            if (aps.length === 0) {
                const emptyRow = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
                emptyRow.set_child(new Gtk.Label({
                    label: t("settings.network.ap.empty"),
                    css_classes: ["crystal-row-subtitle"],
                    margin_top: 12, margin_bottom: 12, margin_start: 16,
                    halign: Gtk.Align.START,
                }))
                apList.append(emptyRow)
            }

            apBox.visible = enabled
        }

        scanBtn.connect("clicked", () => {
            scanBtn.sensitive = false
            Net.rescan().then(() => {
                setTimeout(() => {
                    refreshAps()
                    scanBtn.sensitive = true
                }, 2000)
            })
        })

        network.wifi.connect("notify::access-points", refreshAps)
        network.wifi.connect("notify::enabled", refreshAps)
        network.wifi.connect("notify::active-access-point", refreshAps)
        refreshAps()
        page.append(apBox)

    } else {
        const { box, listBox } = listGroup(t("settings.network.group.wireless"))
        listBox.append(createRow(
            t("settings.network.hw-status"),
            t("settings.network.no-adapter.desc"),
            staticLabel(t("settings.network.error.no-wifi-hw"))
        ))
        page.append(box)
    }

    // ── VPN ───────────────────────────────────────────────────────────────────
    const { box: vpnBox, listBox: vpnList } = listGroup(t("settings.network.group.vpn"))

    const emptyVpn = new Gtk.Label({
        label: t("settings.network.vpn.no-profiles"),
        css_classes: ["crystal-row-subtitle"],
        margin_top: 12, margin_bottom: 12, margin_start: 16,
        halign: Gtk.Align.START,
    })

    const refreshVpn = () => {
        let child = vpnList.get_first_child()
        while (child) { vpnList.remove(child); child = vpnList.get_first_child() }

        Net.listVpnProfiles().then(profiles => {
            if (profiles.length === 0) {
                const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
                row.set_child(emptyVpn)
                vpnList.append(row)
            } else {
                profiles.forEach(p => vpnList.append(buildVpnRow(p, refreshVpn)))
            }
        })
    }
    refreshVpn()
    page.append(vpnBox)

    return page
}
