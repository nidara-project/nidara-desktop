import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import { listGroup, createRow, staticLabel, pageHeader, pageBox } from "../SettingsHelpers"

export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: "Servicio de Red no disponible" })

    const page = pageBox("network-page")
    page.append(pageHeader("Red", "Administra las conexiones de red y parámetros técnicos"))

    const getIp = (service: any) => {
        if (!service) return "None"
        if (service.ip4_address && service.ip4_address !== "None") return String(service.ip4_address)
        try {
            const addrs = service.device?.get_ip4_config()?.get_addresses()
            if (addrs?.length > 0) return String(addrs[0].get_address())
        } catch (e) {
            console.warn("[NetworkSettings] Failed to resolve IP:", e)
        }
        return "None"
    }

    // ── Ethernet ──
    if (network.wired) {
        const wiredGroup = listGroup("Cableada (Ethernet)")

        const wiredStatus = staticLabel(
            network.wired.internet === AstalNetwork.Internet.CONNECTED ? "Conectada" : "Desconectada"
        )
        const interfaceLabel = staticLabel(network.wired.device?.interface || "---")
        const ipLabel = staticLabel(getIp(network.wired))

        const updateWired = () => {
            wiredStatus.label = network.wired.internet === AstalNetwork.Internet.CONNECTED
                ? "Conectada" : "Desconectada"
            interfaceLabel.label = String(network.wired.device?.interface || "---")
            ipLabel.label = getIp(network.wired)
        }
        network.wired.connect("notify::internet", updateWired)
        network.wired.connect("notify::ip4-address", updateWired)

        wiredGroup.listBox.append(createRow("Conexión Ethernet", "Estado actual de la interfaz física", wiredStatus))
        wiredGroup.listBox.append(createRow("Interfaz", "Nombre del dispositivo en el núcleo", interfaceLabel))
        wiredGroup.listBox.append(createRow("Dirección IPv4", "Identificador único en la red local", ipLabel))
        page.append(wiredGroup.box)
    }

    // ── Wi-Fi ──
    if (network.wifi && network.wifi.get_devices().length > 0) {
        const wifiGroup = listGroup("Wi-Fi")

        const wifiSwitch = new Gtk.Switch({ active: network.wifi.enabled, valign: Gtk.Align.CENTER })
        wifiSwitch.connect("notify::active", () => { network.wifi.enabled = wifiSwitch.active })
        wifiGroup.listBox.append(createRow("Activar Wi-Fi", "Habilita la sincronización del espectro inalámbrico", wifiSwitch))

        const wifiSsidLabel = staticLabel("---")
        const wifiIpLabel = staticLabel("---")
        const wifiSpeedLabel = staticLabel("---")
        const wifiInterface = staticLabel(String(network.wifi.device?.interface || "---"))

        const updateWifi = () => {
            if (!network.wifi) return
            wifiSsidLabel.label = String(network.wifi.ssid || "Desconectado")
            wifiIpLabel.label = getIp(network.wifi)
            const speed = network.wifi.active_access_point?.speed || 0
            wifiSpeedLabel.label = speed > 0 ? `${speed} Mbps` : "---"
        }
        network.wifi.connect("notify::enabled", updateWifi)
        network.wifi.connect("notify::ssid", updateWifi)
        network.wifi.connect("notify::ip4-address", updateWifi)
        updateWifi()

        wifiGroup.listBox.append(createRow("Interfaz", "Nombre del adaptador inalámbrico", wifiInterface))
        wifiGroup.listBox.append(createRow("Punto de Acceso", "Red conectada actualmente", wifiSsidLabel))
        wifiGroup.listBox.append(createRow("Dirección IP", "Asignación actual de la red inalámbrica", wifiIpLabel))
        wifiGroup.listBox.append(createRow("Velocidad", "Rendimiento máximo teórico", wifiSpeedLabel))
        page.append(wifiGroup.box)

        // AP List
        const apListGroup = listGroup("Puntos de Acceso Cercanos")
        const refreshAps = () => {
            if (!network.wifi) return
            let child = apListGroup.listBox.get_first_child()
            while (child) { apListGroup.listBox.remove(child); child = apListGroup.listBox.get_first_child() }

            const aps = (network.wifi.get_access_points() || []).sort((a: any, b: any) => b.strength - a.strength)
            aps.slice(0, 10).forEach((ap: any) => {
                if (!ap.ssid) return
                const btn = new Gtk.Button({
                    label: ap.active ? "Conectado" : "Conectar",
                    css_classes: [ap.active ? "accent-pill" : "flat-pill"],
                    valign: Gtk.Align.CENTER,
                })
                apListGroup.listBox.append(
                    createRow(ap.ssid, `Intensidad: ${ap.strength}% | ${ap.frequency}MHz`, btn)
                )
            })
            apListGroup.box.visible = aps.length > 0 && network.wifi.enabled
        }
        network.wifi.connect("access-points-changed", refreshAps)
        refreshAps()
        page.append(apListGroup.box)

    } else {
        const noWifiGroup = listGroup("Inalámbrica")
        noWifiGroup.listBox.append(
            createRow("Estado del Hardware", "No se encontró ningún adaptador compatible",
                staticLabel("Hardware Wi-Fi no detectado"))
        )
        page.append(noWifiGroup.box)
    }

    return page
}
