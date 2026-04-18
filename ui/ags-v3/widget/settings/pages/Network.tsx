import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { listGroup, createRow, staticLabel, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: t("settings.network.label.servicio-de-red-no-disponible") })

    const page = pageBox("network-page")
    page.append(pageHeader(t("settings.network.page.title.red"), t("settings.network.page.subtitle.administra-las-conexiones-de-red-y-param")))

    const getIp = (service: any) => {
        if (!service) return t("settings.network.label.none")
        if (service.ip4_address && service.ip4_address !== "None") return String(service.ip4_address)
        try {
            const addrs = service.device?.get_ip4_config()?.get_addresses()
            if (addrs?.length > 0) return String(addrs[0].get_address())
        } catch (e) {
            console.warn("[NetworkSettings] Failed to resolve IP:", e)
        }
        return t("settings.network.label.none")
    }

    // ── Ethernet ──
    if (network.wired) {
        const wiredGroup = listGroup(t("settings.network.group.cableada-ethernet"))

        const wiredStatus = staticLabel(
            network.wired.internet === AstalNetwork.Internet.CONNECTED
                ? t("settings.network.label.conectada") : t("settings.network.label.desconectada")
        )
        const interfaceLabel = staticLabel(network.wired.device?.interface || "---")
        const ipLabel = staticLabel(getIp(network.wired))

        const updateWired = () => {
            wiredStatus.label = network.wired.internet === AstalNetwork.Internet.CONNECTED
                ? t("settings.network.label.conectada") : t("settings.network.label.desconectada")
            interfaceLabel.label = String(network.wired.device?.interface || "---")
            ipLabel.label = getIp(network.wired)
        }
        network.wired.connect("notify::internet", updateWired)
        network.wired.connect("notify::ip4-address", updateWired)

        wiredGroup.listBox.append(createRow(t("settings.network.row.label.conexion-ethernet"), t("settings.network.row.desc.estado-actual-de-la-interfaz-fisica"), wiredStatus))
        wiredGroup.listBox.append(createRow(t("settings.network.row.label.interfaz"), t("settings.network.row.desc.nombre-del-dispositivo-en-el-nucleo"), interfaceLabel))
        wiredGroup.listBox.append(createRow(t("settings.network.row.label.direccion-ipv4"), t("settings.network.row.desc.identificador-unico-en-la-red-local"), ipLabel))
        page.append(wiredGroup.box)
    }

    // ── Wi-Fi ──
    if (network.wifi && network.wifi.get_devices().length > 0) {
        const wifiGroup = listGroup(t("settings.network.group.wi-fi"))

        const wifiSwitch = new Gtk.Switch({ active: network.wifi.enabled, valign: Gtk.Align.CENTER })
        wifiSwitch.connect("notify::active", () => { network.wifi.enabled = wifiSwitch.active })
        wifiGroup.listBox.append(createRow(t("settings.network.row.label.activar-wi-fi"), t("settings.network.row.desc.habilita-la-sincronizacion-del-espectro-"), wifiSwitch))

        const wifiSsidLabel = staticLabel("---")
        const wifiIpLabel = staticLabel("---")
        const wifiSpeedLabel = staticLabel("---")
        const wifiInterface = staticLabel(String(network.wifi.device?.interface || "---"))

        const updateWifi = () => {
            if (!network.wifi) return
            wifiSsidLabel.label = String(network.wifi.ssid || t("settings.network.label.desconectado"))
            wifiIpLabel.label = getIp(network.wifi)
            const speed = network.wifi.active_access_point?.speed || 0
            wifiSpeedLabel.label = speed > 0 ? `${speed} Mbps` : "---"
        }
        network.wifi.connect("notify::enabled", updateWifi)
        network.wifi.connect("notify::ssid", updateWifi)
        network.wifi.connect("notify::ip4-address", updateWifi)
        updateWifi()

        wifiGroup.listBox.append(createRow(t("settings.network.row.label.interfaz"), t("settings.network.row.desc.nombre-del-adaptador-inalambrico"), wifiInterface))
        wifiGroup.listBox.append(createRow(t("settings.network.row.label.punto-de-acceso"), t("settings.network.row.desc.red-conectada-actualmente"), wifiSsidLabel))
        wifiGroup.listBox.append(createRow(t("settings.network.row.label.direccion-ip"), t("settings.network.row.desc.asignacion-actual-de-la-red-inalambrica"), wifiIpLabel))
        wifiGroup.listBox.append(createRow(t("settings.network.row.label.velocidad"), t("settings.network.row.desc.rendimiento-maximo-teorico"), wifiSpeedLabel))
        page.append(wifiGroup.box)

        // AP List
        const apListGroup = listGroup(t("settings.network.group.puntos-de-acceso-cercanos"))
        const refreshAps = () => {
            if (!network.wifi) return
            let child = apListGroup.listBox.get_first_child()
            while (child) { apListGroup.listBox.remove(child); child = apListGroup.listBox.get_first_child() }

            const aps = (network.wifi.get_access_points() || []).sort((a: any, b: any) => b.strength - a.strength)
            aps.slice(0, 10).forEach((ap: any) => {
                if (!ap.ssid) return
                const btn = new Gtk.Button({
                    label: ap.active ? t("settings.network.ap.label.conectado") : t("settings.network.ap.label.conectar"),
                    css_classes: [ap.active ? "accent-pill" : "flat-pill"],
                    valign: Gtk.Align.CENTER,
                })
                apListGroup.listBox.append(
                    createRow(ap.ssid, `${t("settings.network.ap.desc.intensidad")} ${ap.strength}% | ${ap.frequency}MHz`, btn)
                )
            })
            apListGroup.box.visible = aps.length > 0 && network.wifi.enabled
        }
        network.wifi.connect("access-points-changed", refreshAps)
        refreshAps()
        page.append(apListGroup.box)

    } else {
        const noWifiGroup = listGroup(t("settings.network.group.inalambrica"))
        noWifiGroup.listBox.append(
            createRow(t("settings.network.row.label.estado-del-hardware"), t("settings.network.row.desc.no-se-encontro-ningun-adaptador-compatib"),
                staticLabel(t("settings.network.label.hw-wifi-no-detectado")))
        )
        page.append(noWifiGroup.box)
    }

    return page
}
