import { Astal, Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"

/**
 * Network Settings Page 🎨 - Crystal V3 (macOS Tahoe Inspired)
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

    // Header Section (Tahoe Style)
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
        label: "Administra las conexiones de red y Wi-Fi",
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

    // ── Helper: Generic Row Builder ──
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
        
        return new Gtk.ListBoxRow({ child: box, css_classes: ["settings-item-row"] })
    }

    // ── Ethernet Section ──
    if (network.wired) {
        const wiredGroup = listGroup("Cableada (Ethernet)")
        const wiredStatusLabel = new Gtk.Label({
            label: network.wired.internet === AstalNetwork.Internet.CONNECTED ? "Conectada" : "Desconectada",
            css_classes: ["settings-row-status"],
            halign: Gtk.Align.END
        })
        
        network.wired.connect("notify::internet", () => {
            wiredStatusLabel.label = network.wired.internet === AstalNetwork.Internet.CONNECTED ? "Conectada" : "Desconectada"
        })

        const wiredIcon = new Gtk.Image({ 
            icon_name: "network-wired-symbolic", 
            pixel_size: 18,
            css_classes: [network.wired.internet === AstalNetwork.Internet.CONNECTED ? "accent-icon" : ""]
        })

        wiredGroup.listBox.append(createRow("Conexión Ethernet", "Estado actual de la interfaz física", wiredStatusLabel))
        page.append(wiredGroup.box)
    }

    // ── Wi-Fi Section (Conditional on Hardware) ──
    if (network.wifi && network.wifi.get_devices().length > 0) {
        const wifiGroup = listGroup("Wi-Fi")
        
        const wifiSwitch = new Gtk.Switch({
            active: network.wifi.enabled,
            valign: Gtk.Align.CENTER
        })
        wifiSwitch.connect("notify::active", () => {
            network.wifi.enabled = wifiSwitch.active
        })

        wifiGroup.listBox.append(createRow("Activar Wi-Fi", "Conéctate a redes inalámbricas cercanas", wifiSwitch))
        page.append(wifiGroup.box)

        // AP List Section
        const apListGroup = listGroup("Puntos de Acceso")
        
        const refreshWifi = () => {
            if (!network.wifi) return

            let child = apListGroup.listBox.get_first_child()
            while (child) {
                apListGroup.listBox.remove(child)
                child = apListGroup.listBox.get_first_child()
            }

            const accessPoints = network.wifi.get_access_points() || []
            accessPoints.sort((a, b) => b.strength - a.strength)

            accessPoints.forEach(ap => {
                if (!ap.ssid) return

                const connectBtn = new Gtk.Button({
                    label: ap.active ? "Conectado" : "Conectar",
                    css_classes: [ap.active ? "accent-pill" : "flat-pill"],
                    valign: Gtk.Align.CENTER
                })

                const row = createRow(ap.ssid, `Intensidad: ${ap.strength}%`, connectBtn)
                apListGroup.listBox.append(row)
            })

            apListGroup.box.visible = accessPoints.length > 0 && network.wifi.enabled
        }

        network.wifi.connect("notify::enabled", refreshWifi)
        network.wifi.connect("access-points-changed", refreshWifi)
        refreshWifi()

        page.append(apListGroup.box)
    } else {
        // Optional informative row when no Wifi hardware is found
        const noWifiGroup = listGroup("Inalámbrica")
        const noWifiLabel = new Gtk.Label({
            label: "Hardware Wi-Fi no detectado",
            css_classes: ["settings-row-status", "dimmed"],
            halign: Gtk.Align.END
        })
        noWifiGroup.listBox.append(createRow("Wi-Fi", "No se encontró ningún adaptador inalámbrico", noWifiLabel))
        page.append(noWifiGroup.box)
    }

    return page
}
