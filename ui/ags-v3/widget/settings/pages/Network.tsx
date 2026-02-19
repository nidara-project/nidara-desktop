import { Astal, Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"

/**
 * Network Settings Page 🛰️
 */
export default function NetworkPage() {
    const network = AstalNetwork.get_default()
    if (!network) return new Gtk.Label({ label: "Servicio de Red no disponible" })

    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page"],
        margin_start: 40,
        margin_end: 40,
        margin_top: 40
    })

    const title = new Gtk.Label({
        label: "Red",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START
    })

    page.append(title)
    page.append(new Gtk.Separator())

    // WiFi Section
    const wifiBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12
    })

    const wifiHeader = new Gtk.Box({ spacing: 12 })
    wifiHeader.append(new Gtk.Label({
        label: "Wi-Fi",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START,
        hexpand: true
    }))

    const wifiSwitch = new Gtk.Switch({
        active: network.wifi?.enabled || false,
        valign: Gtk.Align.CENTER
    })
    wifiSwitch.connect("notify::active", () => {
        if (network.wifi) network.wifi.enabled = wifiSwitch.active
    })
    wifiHeader.append(wifiSwitch)
    wifiBox.append(wifiHeader)

    const wifiList = new Gtk.ListBox({
        css_classes: ["settings-list"],
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
        // Sort by strength and connected
        accessPoints.sort((a, b) => b.strength - a.strength)

        accessPoints.forEach(ap => {
            if (!ap.ssid) return

            const rowContent = new Gtk.Box({
                spacing: 16,
                margin_start: 16,
                margin_end: 16,
                margin_top: 12,
                margin_bottom: 12
            })

            const strengthIcon = new Gtk.Image({
                icon_name: ap.icon_name || "network-wireless-signal-excellent-symbolic",
                pixel_size: 20
            })
            rowContent.append(strengthIcon)

            const label = new Gtk.Label({
                label: ap.ssid,
                hexpand: true,
                halign: Gtk.Align.START
            })
            rowContent.append(label)

            if (network.wifi.active_access_point === ap) {
                rowContent.append(new Gtk.Label({
                    label: "Conectado",
                    css_classes: ["connected-label"]
                }))
                rowContent.append(new Gtk.Image({
                    icon_name: "object-select-symbolic",
                    pixel_size: 16
                }))
            }

            const btn = new Gtk.Button({
                child: rowContent,
                css_classes: ["settings-row-btn"]
            })

            btn.connect("clicked", () => {
                // Connection logic would go here, usually requiring a password prompt
                console.log(`[NetworkPage] Connecting to ${ap.ssid}...`)
            })

            wifiList.append(new Gtk.ListBoxRow({ child: btn }))
        })
    }

    wifiBox.append(wifiList)
    page.append(wifiBox)

    // Initial refresh
    refreshWifi()
    network.wifi?.connect("notify::access-points", refreshWifi)
    network.wifi?.connect("notify::active-access-point", refreshWifi)

    return page
}
