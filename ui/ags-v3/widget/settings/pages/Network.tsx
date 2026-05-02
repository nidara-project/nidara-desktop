import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { execAsync } from "ags/process"
import { listGroup, createRow, staticLabel, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

// ── nmcli helpers ─────────────────────────────────────────────────────────────

const NM_AP_FLAGS_PRIVACY = 0x1

function isSecured(ap: any): boolean {
    return (ap.flags & NM_AP_FLAGS_PRIVACY) !== 0
        || (ap.wpa_flags ?? 0) !== 0
        || (ap.rsn_flags ?? 0) !== 0
}

async function hasSavedProfile(ssid: string): Promise<boolean> {
    try {
        const out = await execAsync(["nmcli", "-t", "-f", "NAME", "connection", "show"])
        return out.split("\n").some(line => line.trim() === ssid)
    } catch {
        return false
    }
}

function connectAp(ssid: string, password?: string): Promise<string> {
    const args = ["nmcli", "device", "wifi", "connect", ssid]
    if (password) args.push("password", password)
    return execAsync(args)
}

function disconnectIface(iface: string): Promise<string> {
    return execAsync(["nmcli", "device", "disconnect", iface])
}

function rescan(): Promise<string> {
    return execAsync(["nmcli", "device", "wifi", "rescan"]).catch(() => "")
}

function getIp(service: any): string {
    if (!service) return t("settings.network.label.none")
    if (service.ip4_address && service.ip4_address !== "None") return String(service.ip4_address)
    try {
        const addrs = service.device?.get_ip4_config()?.get_addresses()
        if (addrs?.length > 0) return String(addrs[0].get_address())
    } catch {}
    return t("settings.network.label.none")
}

// ── AP row ────────────────────────────────────────────────────────────────────

function buildApRow(ap: any, iface: string, onRefresh: () => void): Gtk.ListBoxRow {
    const ssid    = ap.ssid as string
    const secured = isSecured(ap)
    let active    = ap.active as boolean

    // Right-side widget: optional lock icon + action button
    const rightBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })

    if (secured) {
        rightBox.append(new Gtk.Image({
            icon_name: "network-wireless-encrypted-symbolic",
            pixel_size: 14,
            opacity: 0.5,
            valign: Gtk.Align.CENTER,
            css_classes: ["cs-icon"],
        }))
    }

    const btn = new Gtk.Button({ valign: Gtk.Align.CENTER })
    rightBox.append(btn)

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.ap.label.conectar")
                btn.remove_css_class("destructive-action")
                btn.add_css_class("suggested-action")
                btn.sensitive = true
                break
            case "disconnect":
                btn.label = t("settings.network.ap.label.desconectar")
                btn.remove_css_class("suggested-action")
                btn.add_css_class("destructive-action")
                btn.sensitive = true
                break
            case "loading":
                btn.label = t("settings.network.ap.label.conectando")
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
            placeholder_text: t("settings.network.ap.placeholder.contrasena"),
            show_peek_icon: true,
            hexpand: true,
        })

        const confirmBtn = new Gtk.Button({
            label: t("settings.network.ap.label.conectar"),
            css_classes: ["suggested-action"],
            hexpand: true,
        })

        const titleLabel = new Gtk.Label({
            label: `${t("settings.network.ap.title.contrasena-para")} ${ssid}`,
            css_classes: ["settings-row-label"],
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
            performConnect(pwd)
        }
        confirmBtn.connect("clicked", submit)
        pwdEntry.connect("activate", submit)

        return pwdPopover
    }

    async function performConnect(password?: string) {
        setState("loading")
        try {
            await connectAp(ssid, password)
            active = true
            setState("disconnect")
            setTimeout(onRefresh, 2000)
        } catch (e) {
            console.error("[Network] connect failed:", e)
            setState("error")
        }
    }

    btn.connect("clicked", async () => {
        if (active) {
            setState("loading")
            try {
                await disconnectIface(iface)
                active = false
                setState("connect")
                setTimeout(onRefresh, 1000)
            } catch (e) {
                console.error("[Network] disconnect failed:", e)
                setState("disconnect")
            }
            return
        }

        const saved = await hasSavedProfile(ssid)
        if (!secured || saved) {
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: t("settings.network.label.servicio-de-red-no-disponible") })

    const page = pageBox("network-page")
    page.append(pageHeader(
        t("settings.network.page.title.red"),
        t("settings.network.page.subtitle.administra-las-conexiones-de-red-y-param")
    ))

    // ── Ethernet ──────────────────────────────────────────────────────────────
    if (network.wired) {
        const { box, listBox } = listGroup(t("settings.network.group.cableada-ethernet"))

        const wiredStatus    = staticLabel(
            network.wired.internet === AstalNetwork.Internet.CONNECTED
                ? t("settings.network.label.conectada")
                : t("settings.network.label.desconectada")
        )
        const interfaceLabel = staticLabel(network.wired.device?.interface || "---")
        const ipLabel        = staticLabel(getIp(network.wired))

        const updateWired = () => {
            wiredStatus.label    = network.wired.internet === AstalNetwork.Internet.CONNECTED
                ? t("settings.network.label.conectada")
                : t("settings.network.label.desconectada")
            interfaceLabel.label = String(network.wired.device?.interface || "---")
            ipLabel.label        = getIp(network.wired)
        }
        network.wired.connect("notify::internet", updateWired)
        network.wired.connect("notify::ip4-address", updateWired)

        listBox.append(createRow(t("settings.network.row.label.conexion-ethernet"),  t("settings.network.row.desc.estado-actual-de-la-interfaz-fisica"),    wiredStatus))
        listBox.append(createRow(t("settings.network.row.label.interfaz"),           t("settings.network.row.desc.nombre-del-dispositivo-en-el-nucleo"),     interfaceLabel))
        listBox.append(createRow(t("settings.network.row.label.direccion-ipv4"),     t("settings.network.row.desc.identificador-unico-en-la-red-local"),     ipLabel))
        page.append(box)
    }

    // ── Wi-Fi ─────────────────────────────────────────────────────────────────
    if (network.wifi && network.wifi.get_devices().length > 0) {
        const { box: wifiBox, listBox: wifiList } = listGroup(t("settings.network.group.wi-fi"))

        const wifiSwitch = new Gtk.Switch({ active: network.wifi.enabled, valign: Gtk.Align.CENTER })
        wifiSwitch.connect("notify::active", () => { network.wifi.enabled = wifiSwitch.active })
        wifiList.append(createRow(t("settings.network.row.label.activar-wi-fi"), t("settings.network.row.desc.habilita-la-sincronizacion-del-espectro-"), wifiSwitch))

        const ssidLabel      = staticLabel("---")
        const ipLabel        = staticLabel("---")
        const speedLabel     = staticLabel("---")
        const ifaceLabel     = staticLabel(String(network.wifi.device?.interface || "---"))

        const updateWifi = () => {
            if (!network.wifi) return
            ssidLabel.label  = String(network.wifi.ssid || t("settings.network.label.desconectado"))
            ipLabel.label    = getIp(network.wifi)
            const spd        = network.wifi.active_access_point?.speed || 0
            speedLabel.label = spd > 0 ? `${spd} Mbps` : "---"
        }
        network.wifi.connect("notify::enabled", updateWifi)
        network.wifi.connect("notify::ssid", updateWifi)
        network.wifi.connect("notify::ip4-address", updateWifi)
        updateWifi()

        wifiList.append(createRow(t("settings.network.row.label.interfaz"),      t("settings.network.row.desc.nombre-del-adaptador-inalambrico"),          ifaceLabel))
        wifiList.append(createRow(t("settings.network.row.label.punto-de-acceso"), t("settings.network.row.desc.red-conectada-actualmente"),              ssidLabel))
        wifiList.append(createRow(t("settings.network.row.label.direccion-ip"),  t("settings.network.row.desc.asignacion-actual-de-la-red-inalambrica"),   ipLabel))
        wifiList.append(createRow(t("settings.network.row.label.velocidad"),     t("settings.network.row.desc.rendimiento-maximo-teorico"),                speedLabel))
        page.append(wifiBox)

        // ── AP list ───────────────────────────────────────────────────────────
        const iface = String(network.wifi.device?.interface || "")
        const { box: apBox, listBox: apList } = listGroup(t("settings.network.group.puntos-de-acceso-cercanos"))

        const scanBtn = new Gtk.Button({
            label: t("settings.network.ap.label.buscar-redes"),
            css_classes: ["flat"],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        })

        const headerBox = new Gtk.Box({ spacing: 0, hexpand: true })
        const groupTitleLabel = new Gtk.Label({
            label: t("settings.network.group.puntos-de-acceso-cercanos").toUpperCase(),
            css_classes: ["settings-group-title"],
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

        function refreshAps() {
            if (!network.wifi) return
            let child = apList.get_first_child()
            while (child) { apList.remove(child); child = apList.get_first_child() }

            const aps: any[] = (network.wifi.get_access_points() || [])
                .filter((ap: any) => !!ap.ssid)
                .sort((a: any, b: any) => b.strength - a.strength)
                .slice(0, 12)

            for (const ap of aps) {
                apList.append(buildApRow(ap, iface, refreshAps))
            }

            apBox.visible = aps.length > 0 && network.wifi.enabled
        }

        scanBtn.connect("clicked", () => {
            scanBtn.sensitive = false
            rescan().then(() => {
                setTimeout(() => {
                    refreshAps()
                    scanBtn.sensitive = true
                }, 2000)
            })
        })

        network.wifi.connect("access-points-changed", refreshAps)
        refreshAps()
        page.append(apBox)

    } else {
        const { box, listBox } = listGroup(t("settings.network.group.inalambrica"))
        listBox.append(createRow(
            t("settings.network.row.label.estado-del-hardware"),
            t("settings.network.row.desc.no-se-encontro-ningun-adaptador-compatib"),
            staticLabel(t("settings.network.label.hw-wifi-no-detectado"))
        ))
        page.append(box)
    }

    return page
}
