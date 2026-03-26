import { Astal, Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"

/**
 * Network Settings Page 
 */
export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: "Servicio de Red no disponible" })

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page"],
        margin_start: 30,
        margin_end: 30,
        margin_top: 30,
        margin_bottom: 30,
    })

    // Header Section
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_bottom: 12
    })
    headerBox.append(new Gtk.Label({
        label: "Red",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START
    }))
    headerBox.append(new Gtk.Label({
        label: "Administra las conexiones de red y Wi-Fi",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START
    }))
    page.append(headerBox)

    // Wi-Fi Toggle Row (Boxed List Row)
    const wifiStatusList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "boxed-list"],
        selection_mode: Gtk.SelectionMode.NONE,
        margin_bottom: 12
    })

    const wifiToggleBox = new Gtk.Box({
        spacing: 12,
        margin_start: 12,
        margin_end: 12,
        margin_top: 10,
        margin_bottom: 10
    })

    wifiToggleBox.append(new Gtk.Image({
        icon_name: "network-wireless-symbolic",
        pixel_size: 18
    }))
    wifiToggleBox.append(new Gtk.Label({
        label: "Activar Wi-Fi",
        css_classes: ["settings-row-label"],
        hexpand: true,
        halign: Gtk.Align.START
    }))

    const wifiSwitch = new Gtk.Switch({
        active: network.wifi?.enabled || false,
        valign: Gtk.Align.CENTER
    })
    wifiSwitch.connect("notify::active", () => {
        if (network.wifi) network.wifi.enabled = wifiSwitch.active
    })
    wifiToggleBox.append(wifiSwitch)
    wifiStatusList.append(new Gtk.ListBoxRow({ child: wifiToggleBox }))
    page.append(wifiStatusList)

    // AP List Section
    const wifiList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "boxed-list"],
        selection_mode: Gtk.SelectionMode.NONE
    })

    const refreshWifi = () => {
        if (!network.wifi) return

        let child = wifiList.get_first_child()
        while (child) {
            wifiList.remove(child)
            child = wifiList.get_first_child()
        }

        const accessPoints = network.wifi.get_access_points() || []
        accessPoints.sort((a, b) => b.strength - a.strength)

        accessPoints.forEach(ap => {
            if (!ap.ssid) return

            const rowContent = new Gtk.Box({
                spacing: 16,
                margin_start: 12,
                margin_end: 12,
                margin_top: 10,
                margin_bottom: 10
            })

            rowContent.append(new Gtk.Image({
                icon_name: ap.icon_name || "network-wireless-signal-excellent-symbolic",
                pixel_size: 18
            }))

            rowContent.append(new Gtk.Label({
                label: ap.ssid,
                hexpand: true,
                halign: Gtk.Align.START,
                css_classes: ["settings-row-label"]
            }))

            if (network.wifi.active_access_point === ap) {
                rowContent.append(new Gtk.Label({
                    label: "Conectado",
                    css_classes: ["settings-row-status"]
                }))
                rowContent.append(new Gtk.Image({
                    icon_name: "object-select-symbolic",
                    pixel_size: 14
                }))
            }

            const row = new Gtk.ListBoxRow({ child: rowContent })
            wifiList.append(row)
        })
    }

    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    groupBox.append(new Gtk.Label({
        label: "Redes Disponibles",
        css_classes: ["settings-group-title"],
        halign: Gtk.Align.START,
        margin_start: 6
    }))
    groupBox.append(wifiList)
    page.append(groupBox)

    // Initial refresh
    refreshWifi()
    network.wifi?.connect("notify::access-points", refreshWifi)
    network.wifi?.connect("notify::active-access-point", refreshWifi)

    return page
}
