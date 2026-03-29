import { Astal, Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"

/**
 * Network Settings Page 🎨 - Crystal V3 (macOS Tahoe Inspired)
 * Enhanced with "Medical-Grade" technical details.
 */
export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: "Servicio de Red no disponible" })

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["settings-page", "network-page"],
        margin_start: 12,
        margin_end: 12,
        margin_top: 40,
        margin_bottom: 40,
    })

    // Header Section
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_bottom: 24,
        margin_start: 6
    })
    
    headerBox.append(new Gtk.Label({
        label: "Red",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    
    headerBox.append(new Gtk.Label({
        label: "Administra las conexiones de red y parámetros técnicos",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    
    page.append(headerBox)

    // ── Helper: Boxed List Group ──
    const listGroup = (title: string) => {
        const box = new Gtk.Box({ 
            orientation: Gtk.Orientation.VERTICAL, 
            spacing: 12,
            css_classes: ["settings-group"] 
        })
        
        if (title) {
            box.append(new Gtk.Label({
                label: title.toUpperCase(),
                css_classes: ["settings-group-title"],
                halign: Gtk.Align.START,
                margin_start: 10
            }))
        }
        
        const listBox = new Gtk.ListBox({
            css_classes: ["settings-list-box", "boxed-list"],
            selection_mode: Gtk.SelectionMode.NONE
        })
        
        box.append(listBox)
        return { box, listBox }
    }

    const createRow = (label: string, subtitle: string, widget: Gtk.Widget) => {
        const box = new Gtk.Box({
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER
        })
        
        text.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        
        if (subtitle) {
            text.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }

        box.append(text)
        box.append(widget)
        
        const lbr = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        lbr.set_child(box)
        return lbr
    }

    const getIp = (service: any) => {
        if (!service) return "None"
        if (service.ip4_address && service.ip4_address !== "None") return String(service.ip4_address)
        
        try {
            const dev = service.device
            const config = dev?.get_ip4_config()
            const addrs = config?.get_addresses()
            if (addrs && addrs.length > 0) {
                return String(addrs[0].get_address())
            }
        } catch (e) {
            console.warn("[NetworkSettings] Failed to resolve IP from config:", e)
        }
        
        return "None"
    }

    const staticLabel = (text: any) => new Gtk.Label({
        label: String(text ?? "---"),
        css_classes: ["settings-row-status", "dimmed"],
        halign: Gtk.Align.END
    })

    // ── Ethernet Section ──
    if (network.wired) {
        const wiredGroup = listGroup("Cableada (Ethernet)")
        
        // Main Status
        const wiredStatus = staticLabel(network.wired.internet === AstalNetwork.Internet.CONNECTED ? "Conectada" : "Desconectada")
        wiredGroup.listBox.append(createRow("Conexión Ethernet", "Estado actual de la interfaz física", wiredStatus))

        // Technical Details (Dynamically updated)
        const interfaceName = network.wired.device?.interface || "---"
        const interfaceLabel = staticLabel(interfaceName)
        const ipLabel = staticLabel(getIp(network.wired))
        
        const updateWired = () => {
            wiredStatus.label = network.wired.internet === AstalNetwork.Internet.CONNECTED ? "Conectada" : "Desconectada"
            interfaceLabel.label = String(network.wired.device?.interface || "---")
            ipLabel.label = getIp(network.wired)
        }

        network.wired.connect("notify::internet", updateWired)
        network.wired.connect("notify::ip4-address", updateWired)

        wiredGroup.listBox.append(createRow("Interfaz", "Nombre del dispositivo en el núcleo", interfaceLabel))
        wiredGroup.listBox.append(createRow("Dirección IPv4", "Identificador único en la red local", ipLabel))
        
        page.append(wiredGroup.box)
    }

    // ── Wi-Fi Section ──
    if (network.wifi && network.wifi.get_devices().length > 0) {
        const wifiGroup = listGroup("Wi-Fi")
        
        const wifiSwitch = new Gtk.Switch({
            active: network.wifi.enabled,
            valign: Gtk.Align.CENTER
        })
        wifiSwitch.connect("notify::active", () => {
            network.wifi.enabled = wifiSwitch.active
        })

        wifiGroup.listBox.append(createRow("Activar Wi-Fi", "Habilita la sincronización del espectro inalámbrico", wifiSwitch))
        
        // Technical Details
        const wifiSsidLabel = staticLabel("---")
        const wifiIpLabel = staticLabel("---")
        const wifiSpeedLabel = staticLabel("---")

        const updateWifiInfo = () => {
            if (!network.wifi) return
            wifiSsidLabel.label = String(network.wifi.ssid || "Desconectado")
            wifiIpLabel.label = getIp(network.wifi)
            const speed = network.wifi.active_access_point?.speed || 0
            wifiSpeedLabel.label = speed > 0 ? `${speed} Mbps` : "---"
        }

        network.wifi.connect("notify::enabled", updateWifiInfo)
        network.wifi.connect("notify::ssid", updateWifiInfo)
        network.wifi.connect("notify::ip4-address", updateWifiInfo)
        updateWifiInfo()

        const wifiInterface = staticLabel(String(network.wifi.device?.interface || "---"))
        wifiGroup.listBox.append(createRow("Interfaz", "Nombre del adaptador inalámbrico", wifiInterface))
        wifiGroup.listBox.append(createRow("Punto de Acceso", "Red conectada actualmente", wifiSsidLabel))
        wifiGroup.listBox.append(createRow("Dirección IP", "Asignación actual de la red inalámbrica", wifiIpLabel))
        wifiGroup.listBox.append(createRow("Velocidad", "Rendimiento máximo teórico", wifiSpeedLabel))

        page.append(wifiGroup.box)

        // AP List Section
        const apListGroup = listGroup("Puntos de Acceso Cercanos")
        
        const refreshAps = () => {
            if (!network.wifi) return

            let child = apListGroup.listBox.get_first_child()
            while (child) {
                apListGroup.listBox.remove(child)
                child = apListGroup.listBox.get_first_child()
            }

            const accessPoints = network.wifi.get_access_points() || []
            accessPoints.sort((a, b) => b.strength - a.strength)

            accessPoints.slice(0, 10).forEach(ap => {
                if (!ap.ssid) return

                const connectBtn = new Gtk.Button({
                    label: ap.active ? "Conectado" : "Conectar",
                    css_classes: [ap.active ? "accent-pill" : "flat-pill"],
                    valign: Gtk.Align.CENTER
                })

                const row = createRow(ap.ssid, `Intensidad: ${ap.strength}% | Band: ${ap.frequency}MHz`, connectBtn)
                apListGroup.listBox.append(row)
            })

            apListGroup.box.visible = accessPoints.length > 0 && network.wifi.enabled
        }

        network.wifi.connect("access-points-changed", refreshAps)
        refreshAps()
        page.append(apListGroup.box)

    } else {
        const noWifiGroup = listGroup("Inalámbrica")
        const noWifiLabel = staticLabel("Hardware Wi-Fi no detectado")
        noWifiGroup.listBox.append(createRow("Estado del Hardware", "No se encontró ningún adaptador compatible", noWifiLabel))
        page.append(noWifiGroup.box)
    }

    return page
}
