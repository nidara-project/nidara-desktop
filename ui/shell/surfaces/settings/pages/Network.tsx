import { Gtk } from "ags/gtk4"
import { listGroup, createRow, staticLabel, pageBox, onPageShown, bindWhileRealized, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import * as Net from "../../../core/NetworkService"
import type { VpnProfile } from "../../../core/NetworkService"
import { NidaraButton, NidaraEmptyRow } from "../../../../lib/nidara-kit"
import { attachTooltip } from "../../../common/Tooltip"
import { safeDisconnect } from "../../../core/signals"

function buildVpnRow(profile: VpnProfile, onRefresh: () => void): Gtk.ListBoxRow {
    let active = profile.active

    const btn = NidaraButton({ pill: true })

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.vpn.btn.connect")
                btn.add_css_class("nidara-btn--primary")
                btn.sensitive = true; break
            case "disconnect":
                // Disconnect is reversible → neutral (secondary). Danger is reserved
                // for destructive actions (forget). See NidaraButton convention.
                btn.label = t("settings.network.vpn.btn.disconnect")
                btn.remove_css_class("nidara-btn--primary")
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
    // An SSID is arbitrary bytes on the wire, so NM hands it over as GLib.Bytes —
    // Net.apSsid is the decoder. Everything else on an AP is read straight off it.
    const ssid    = Net.apSsid(ap)
    const secured = Net.isSecured(ap)
    // NM.AccessPoint has no `active` property — the active AP is derived by the
    // caller from the device's active_access_point.bssid.
    let active    = isActive

    // Right-side widget: optional info + (forget) + action button. (The lock for a
    // secured AP rides next to the SSID via createRow's titleIcon, not here.)
    const rightBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })

    // Lock badge next to the network name when the AP is secured.
    const lockIcon = secured
        ? new Gtk.Image({ gicon: Icons.lock, pixel_size: 13, opacity: 0.5, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] })
        : undefined

    // Network details subpage (security, band, channel, BSSID, IP when connected).
    if (onDetails) {
        const infoBtn = NidaraButton({ variant: "secondary", pill: true, icon: true })
        attachTooltip(infoBtn, t("settings.network.ap.details"), { chrome: false })
        infoBtn.set_child(new Gtk.Image({ gicon: Icons.wifiCog, pixel_size: 16, css_classes: ["nd-icon"] }))
        infoBtn.connect("clicked", onDetails)
        rightBox.append(infoBtn)
    }

    // Forget — only for saved, currently-disconnected networks (you disconnect
    // first, then forget). The row is rebuilt on connect/disconnect so this tracks.
    if (isSaved && !active) {
        const forgetBtn = NidaraButton({
            variant: "danger",
            pill: true,
            icon: true,
        })
        attachTooltip(forgetBtn, t("settings.network.ap.forget"), { chrome: false })
        forgetBtn.set_child(new Gtk.Image({ gicon: Icons.trash, pixel_size: 16, css_classes: ["nd-icon"] }))
        forgetBtn.connect("clicked", async () => {
            forgetBtn.sensitive = false
            try { await Net.forgetProfile(ssid) }
            catch (e) { console.error("[Network] forget failed:", e); forgetBtn.sensitive = true }
            setTimeout(onRefresh, 800)
        })
        rightBox.append(forgetBtn)
    }

    const btn = NidaraButton({ pill: true })
    rightBox.append(btn)

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.ap.connect")
                btn.add_css_class("nidara-btn--primary")
                btn.sensitive = true
                break
            case "disconnect":
                // Reversible → neutral (secondary); danger is reserved for forget.
                btn.label = t("settings.network.ap.disconnect")
                btn.remove_css_class("nidara-btn--primary")
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

        const confirmBtn = NidaraButton({
            label: t("settings.network.ap.connect"),
            variant: "primary",
            pill: true,
        })
        confirmBtn.hexpand = true

        const titleLabel = new Gtk.Label({
            label: `${t("settings.network.ap.password-for")} ${ssid}`,
            css_classes: ["nidara-row-title"],
            halign: Gtk.Align.START,
            ellipsize: 3, // PANGO_ELLIPSIZE_END
            max_width_chars: 26,
        })

        const popBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12, margin_bottom: 12,
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
    return createRow(ssid, subtitle, rightBox, lockIcon)
}

// ── AP detail subpage ───────────────────────────────────────────────────────────

function buildApDetailPage(ap: any): Gtk.Widget {
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
        const b = Net.wifi()?.active_access_point?.bssid
        return !!b && b === ap.bssid
    }

    const update = () => {
        signalLabel.label = `${ap.strength}%`
        const active = isActive()
        connBox.visible = active
        if (!active) return

        const dev = Net.wifi()?.device as any
        let ip = "---", gw = "---", dns = "---", mac = "---", speed = "---"
        try {
            const cfg   = dev?.get_ip4_config?.()
            const addrs = cfg?.get_addresses?.()
            if (addrs?.length > 0) ip = `${addrs[0].get_address()}/${addrs[0].get_prefix()}`
            gw = cfg?.get_gateway?.() || "---"
            const ns = cfg?.get_nameservers?.()
            if (ns?.length > 0) dns = ns.join(", ")
        } catch {}
        try { mac = dev?.get_hw_address?.() || "---" } catch {}
        try { const kbps = dev?.bitrate || 0; if (kbps > 0) speed = `${Math.round(kbps / 1000)} Mbps` } catch {}

        ipLabel.label = ip; gwLabel.label = gw; dnsLabel.label = dns
        macLabel.label = mac; speedLabel.label = speed
    }

    // The signal lives on the AP object itself; IP/speed/active-state live on the
    // wifi + device (covered by watchWifi). Both refresh the page in place.
    const apStrengthId = ap.connect?.("notify::strength", update) ?? 0
    const disposeWifi  = Net.watchWifi(update)
    page.connect("unrealize", () => {
        if (apStrengthId) safeDisconnect(ap, apStrengthId)
        disposeWifi()
    })
    update()

    return page
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NetworkPage(nav?: SettingsNav) {
    // No NetworkManager at all is a different answer from "no adapter": there is
    // nothing to watch, so the page says so once instead of switching placeholders.
    if (!Net.available()) return new Gtk.Label({ label: t("settings.network.error.no-service") })

    const page = pageBox("network-page")

    // Settings builds every page once and caches it for the window's lifetime, so
    // hardware presence cannot be a build-time check — and it WAS one here until
    // NetworkService stopped going through AstalNetwork (tech-debt #22/#71): the
    // old singleton resolved its Wi-Fi/Ethernet wrappers in `construct` and never
    // re-scanned, so the question was unanswerable a second time. It reads
    // NetworkManager directly now, and `watchDevices` fires when an adapter
    // appears or disappears. Every section below is therefore BUILT ALWAYS and
    // switched live at the bottom of this function, the same shape Bluetooth uses
    // for its no-adapter banner. Do not put a device behind an `if` here again.

    // ── Ethernet ──────────────────────────────────────────────────────────────
    const { box: ethBox, listBox: ethList } = listGroup(t("settings.network.group.ethernet"))

    const wiredStatus = staticLabel("---")
    const wiredIface  = staticLabel("---")
    const wiredIp     = staticLabel("---")

    const updateWired = () => {
        const w = Net.wired()
        wiredStatus.label = Net.wiredConnected(w)
            ? t("settings.network.status.connected")
            : t("settings.network.status.disconnected")
        wiredIface.label = w?.device.get_iface() || "---"
        wiredIp.label    = ipOf(w)
    }

    ethList.append(createRow(t("settings.network.ethernet"),  t("settings.network.hw-status.desc"),         wiredStatus))
    ethList.append(createRow(t("settings.network.interface"), t("settings.network.kernel-device.desc"),     wiredIface))
    ethList.append(createRow(t("settings.network.ipv4"),      t("settings.network.ip.desc"),                wiredIp))
    page.append(ethBox)

    // ── Wi-Fi ─────────────────────────────────────────────────────────────────
    const { box: wifiBox, listBox: wifiList } = listGroup(t("settings.network.group.wi-fi"))

    const wifiSwitch = new Gtk.Switch({ active: Net.wifiEnabled(), valign: Gtk.Align.CENTER })
    // state-set issues the radio command; the switch's visible state is driven
    // back from the radio flag so it stays truthful if the radio is toggled
    // elsewhere (CC tile, nmcli) and doesn't fight the command. `syncing` marks
    // the write-back, because GtkSwitch emits state-set for a programmatic
    // `active` too — without it, an external toggle would spawn an nmcli that
    // re-commands the state we are merely reflecting.
    let syncing = false
    wifiSwitch.connect("state-set", (_sw, state) => { if (!syncing) Net.setWifiEnabled(state); return false })

    wifiList.append(createRow(t("settings.network.enable-wifi"), t("settings.network.enable-wifi.desc"), wifiSwitch))

    const ssidLabel  = staticLabel("---")
    const wifiIpLabel = staticLabel("---")
    const speedLabel = staticLabel("---")
    const ifaceLabel = staticLabel("---")

    const updateWifi = () => {
        const w = Net.wifi()

        const enabled = Net.wifiEnabled(w)
        if (wifiSwitch.active !== enabled) { syncing = true; wifiSwitch.active = enabled; syncing = false }

        ifaceLabel.label  = w?.device.get_iface() || "---"
        ssidLabel.label   = w?.ssid || t("settings.network.status.disconnected-hw")
        wifiIpLabel.label = ipOf(w)
        // Link speed is the NM device's bitrate (kb/s); nothing higher up carries it.
        const kbps        = w?.device.bitrate ?? 0
        speedLabel.label  = kbps > 0 ? `${Math.round(kbps / 1000)} Mbps` : "---"
    }

    wifiList.append(createRow(t("settings.network.interface"),    t("settings.network.wireless-interface.desc"), ifaceLabel))
    wifiList.append(createRow(t("settings.network.access-point"), t("settings.network.connected-network.desc"),  ssidLabel))
    wifiList.append(createRow(t("settings.network.ip"),           t("settings.network.access-point.desc"),       wifiIpLabel))
    wifiList.append(createRow(t("settings.network.speed"),        t("settings.network.speed.desc"),              speedLabel))
    page.append(wifiBox)

    // ── AP list ───────────────────────────────────────────────────────────────
    const { box: apBox, listBox: apList } = listGroup(t("settings.network.group.access-points"))

    const scanBtn = NidaraButton({
        label: t("settings.network.ap.scan"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    })

    const headerBox = new Gtk.Box({ spacing: 0, hexpand: true })
    const groupTitleLabel = new Gtk.Label({
        label: t("settings.network.group.access-points").toUpperCase(),
        css_classes: ["nidara-list-title"],
        halign: Gtk.Align.START,
        hexpand: true,
        margin_start: 20,
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
        const wifi = Net.wifi()
        if (!wifi) { apBox.visible = false; return }
        const gen = ++refreshGen

        // Read live: the interface name belongs to whichever adapter is present
        // NOW, and `disconnect` is issued against it by name.
        const iface = wifi.device.get_iface() || ""

        const enabled     = wifi.enabled
        const activeAp    = wifi.active_access_point
        const activeBssid = activeAp?.bssid

        const aps: any[] = (wifi.get_access_points() || [])
            .filter((ap: any) => !!Net.apSsid(ap))
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
            const ssid = Net.apSsid(ap)
            const onDetails = nav
                ? () => nav.pushSubpage({
                    id: `network/ap/${ap.bssid}`,
                    title: ssid,
                    parentId: "network",
                    build: () => buildApDetailPage(ap),
                })
                : undefined
            apList.append(buildApRow(
                ap, iface,
                !!activeBssid && ap.bssid === activeBssid,
                savedSsids.has(ssid),
                refreshAps,
                onDetails,
            ))
        }

        // The Scan button lives in this group's header, so the group must stay
        // visible whenever Wi-Fi is on — otherwise there's no way to scan for
        // the first network. Show an empty placeholder when nothing is found.
        if (aps.length === 0) apList.append(NidaraEmptyRow(t("settings.network.ap.empty")))

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
    page.append(apBox)

    // ── No wireless adapter ───────────────────────────────────────────────────
    const { box: noWifiBox, listBox: noWifiList } = listGroup(t("settings.network.group.wireless"))
    noWifiList.append(createRow(
        t("settings.network.hw-status"),
        t("settings.network.no-adapter.desc"),
        staticLabel(t("settings.network.error.no-wifi-hw"))
    ))
    page.append(noWifiBox)

    // ── Adapter presence ──────────────────────────────────────────────────────
    // The banner ↔ content switch. Called on every realize and on every
    // device-added/device-removed, so plugging a USB dongle in with this page
    // open swaps the "no adapter" group for the live one without a shell reload.
    const applyDevices = () => {
        const hasWired = !!Net.wired()
        const hasWifi  = !!Net.wifi()

        ethBox.visible    = hasWired
        wifiBox.visible   = hasWifi
        noWifiBox.visible = !hasWifi

        if (hasWired) updateWired()
        if (hasWifi) { updateWifi(); refreshAps() }
        else apBox.visible = false
    }

    // Armed per VISIT, not per window: Settings only `remove()`s a page when you
    // navigate away, which unrealizes it without destroying it. Subscribing at
    // build time meant these were torn down the first time the user left and
    // never re-armed — the page came back looking alive but frozen. It also
    // leaked: none of the old handlers were ever disconnected.
    bindWhileRealized(page, () => {
        const disposers = [
            Net.watchDevices(applyDevices),
            Net.watchWired(updateWired),
            Net.watchWifi(updateWifi),
            Net.watchAccessPoints(refreshAps),
        ]
        applyDevices()
        return () => disposers.forEach(d => d())
    })

    // ── VPN ───────────────────────────────────────────────────────────────────
    const { box: vpnBox, listBox: vpnList } = listGroup(t("settings.network.group.vpn"))

    // Bumped on every refresh. `listVpnProfiles` is an async nmcli call and this
    // list is now re-read on every visit, so two refreshes can overlap: without a
    // generation guard the second one clears the list, both promises resolve, and
    // every profile appears twice. Same shape as the AP list's `refreshGen` above.
    let vpnGen = 0
    const refreshVpn = () => {
        const gen = ++vpnGen

        Net.listVpnProfiles().then(profiles => {
            if (gen !== vpnGen) return   // a newer refresh already ran

            let child = vpnList.get_first_child()
            while (child) { vpnList.remove(child); child = vpnList.get_first_child() }

            if (profiles.length === 0) {
                // Built fresh each time, not once and re-appended: the label above was a
                // module-level widget re-parented into a new row on every refresh, which
                // only worked because the old row was removed first.
                vpnList.append(NidaraEmptyRow(t("settings.network.vpn.no-profiles")))
            } else {
                profiles.forEach(p => vpnList.append(buildVpnRow(p, refreshVpn)))
            }
        })
    }
    // Wi-Fi, Ethernet and the AP list are SUBSCRIBED (NM signals), so they keep
    // themselves current. The VPN list is not: it is an `nmcli connection show`
    // that was asked exactly once, at build. Since the page is cached and the
    // window hides rather than closes, a profile added with `nmcli`, imported from
    // a .ovpn, or brought up outside Nidara stayed invisible — and a profile's
    // Connect/Disconnect state was frozen at whatever it was the first time this
    // page was opened. It is a question, so it is re-asked on every visit.
    onPageShown(refreshVpn)
    page.append(vpnBox)

    return page
}
