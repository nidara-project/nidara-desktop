import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import { listGroup, createRow, pageHeader, pageBox, toggleRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

// ── helpers ───────────────────────────────────────────────────────────────────

const rfkillEnabled = (): Promise<boolean> =>
    execAsync(["bash", "-c", "rfkill list bluetooth | grep -q 'Soft blocked: yes' && echo 1 || echo 0"])
        .then(out => out.trim() === "1")
        .catch(() => false)

const bluetoothctlCmd = (args: string[]): Promise<string> =>
    execAsync(["bluetoothctl", ...args]).catch(e => { console.error("[BT]", e); return "" })

interface BTDevice {
    address: string
    name: string
    connected: boolean
    paired: boolean
    trusted: boolean
    icon: string
}

const parseDevices = (out: string): BTDevice[] => {
    const lines = out.split("\n").filter(l => l.startsWith("Device "))
    return lines.map(line => {
        const parts = line.split(" ")
        const address = parts[1] ?? ""
        const name = parts.slice(2).join(" ")
        return { address, name, connected: false, paired: true, trusted: false, icon: "bluetooth-symbolic" }
    })
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BluetoothPage() {
    const page = pageBox("bluetooth-page")
    page.append(pageHeader(t("settings.bluetooth.page.title.bluetooth"), t("settings.bluetooth.page.subtitle.gestiona-dispositivos-bluetooth-empareja")))

    // ── Power toggle ─────────────────────────────────────────────────────────
    const powerGroup = listGroup(t("settings.bluetooth.page.title.bluetooth"))

    const powerSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: false })
    let powerChanging = false

    powerSwitch.connect("state-set", (_: any, state: boolean) => {
        if (powerChanging) return false
        bluetoothctlCmd(["power", state ? "on" : "off"]).then(() => refreshDevices())
        return false
    })

    powerGroup.listBox.append(createRow(t("settings.bluetooth.row.label.activar-bluetooth"), t("settings.bluetooth.row.desc.encender-o-apagar-el-adaptador-bluetooth"), powerSwitch))
    page.append(powerGroup.box)

    // ── Paired devices ────────────────────────────────────────────────────────
    const devicesGroup = listGroup(t("settings.bluetooth.group.dispositivos-emparejados"))
    page.append(devicesGroup.box)

    // ── Scan ─────────────────────────────────────────────────────────────────
    const scanGroup = listGroup(t("settings.bluetooth.group.buscar-dispositivos"))
    const scanBtn = new Gtk.Button({
        label: t("settings.bluetooth.label.buscar-ahora"),
        css_classes: ["suggested-action"],
        valign: Gtk.Align.CENTER,
        hexpand: false,
    })
    const scanSpinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER, visible: false })
    const scanBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    scanBox.append(scanSpinner)
    scanBox.append(scanBtn)

    let scanTimeoutId: number | null = null

    scanBtn.connect("clicked", () => {
        scanBtn.sensitive = false
        scanSpinner.visible = true
        scanSpinner.start()
        bluetoothctlCmd(["--timeout", "8", "scan", "on"]).then(() => {
            if (scanTimeoutId !== null) GLib.source_remove(scanTimeoutId)
            scanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8500, () => {
                scanTimeoutId = null
                scanBtn.sensitive = true
                scanSpinner.stop()
                scanSpinner.visible = false
                refreshDevices()
                return GLib.SOURCE_REMOVE
            })
        })
    })

    scanGroup.listBox.append(createRow(
        t("settings.bluetooth.row.label.escanear"),
        t("settings.bluetooth.row.desc.busca-dispositivos-bluetooth-cercanos-du"),
        scanBox
    ))
    page.append(scanGroup.box)

    // ── Nearby devices list ───────────────────────────────────────────────────
    const nearbyGroup = listGroup(t("settings.bluetooth.group.dispositivos-detectados"))
    page.append(nearbyGroup.box)

    // ── Refresh logic ─────────────────────────────────────────────────────────
    const rebuildDeviceList = (
        listBox: Gtk.ListBox,
        devices: BTDevice[],
        allowActions: boolean
    ) => {
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        if (devices.length === 0) {
            const empty = new Gtk.Label({
                label: t("settings.bluetooth.label.sin-dispositivos"),
                css_classes: ["settings-placeholder"],
                margin_top: 12,
                margin_bottom: 12,
            })
            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(empty)
            listBox.append(row)
            return
        }

        devices.forEach(dev => {
            const nameLabel = new Gtk.Label({
                label: dev.name || dev.address,
                css_classes: ["settings-row-label"],
                halign: Gtk.Align.START,
                hexpand: true,
                ellipsize: 3,
            })
            const addrLabel = new Gtk.Label({
                label: dev.address,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            })
            const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
            textBox.append(nameLabel)
            textBox.append(addrLabel)

            const rowBox = new Gtk.Box({
                spacing: 12,
                margin_start: 16,
                margin_end: 16,
                margin_top: 12,
                margin_bottom: 12,
            })
            rowBox.append(new Gtk.Image({
                icon_name: "bluetooth-symbolic",
                pixel_size: 20,
                valign: Gtk.Align.CENTER,
            }))
            rowBox.append(textBox)

            if (allowActions) {
                if (dev.connected) {
                    const disconnectBtn = new Gtk.Button({
                        label: t("settings.bluetooth.label.desconectar"),
                        css_classes: ["settings-row-action"],
                        valign: Gtk.Align.CENTER,
                    })
                    disconnectBtn.connect("clicked", () => {
                        bluetoothctlCmd(["disconnect", dev.address]).then(() => refreshDevices())
                    })
                    rowBox.append(disconnectBtn)
                } else {
                    const connectBtn = new Gtk.Button({
                        label: t("settings.bluetooth.label.conectar"),
                        css_classes: ["suggested-action", "settings-row-action"],
                        valign: Gtk.Align.CENTER,
                    })
                    connectBtn.connect("clicked", () => {
                        bluetoothctlCmd(["connect", dev.address]).then(() => refreshDevices())
                    })
                    rowBox.append(connectBtn)
                }

                const removeBtn = new Gtk.Button({
                    child: new Gtk.Image({ icon_name: "edit-delete-symbolic", pixel_size: 16 }),
                    css_classes: ["settings-row-action", "destructive-action"],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: t("settings.bluetooth.tooltip.olvidar-dispositivo"),
                })
                removeBtn.connect("clicked", () => {
                    bluetoothctlCmd(["remove", dev.address]).then(() => refreshDevices())
                })
                rowBox.append(removeBtn)
            } else {
                const pairBtn = new Gtk.Button({
                    label: t("settings.bluetooth.label.emparejar"),
                    css_classes: ["settings-row-action"],
                    valign: Gtk.Align.CENTER,
                })
                pairBtn.connect("clicked", () => {
                    bluetoothctlCmd(["pair", dev.address]).then(() => {
                        bluetoothctlCmd(["trust", dev.address]).then(() => refreshDevices())
                    })
                })
                rowBox.append(pairBtn)
            }

            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(rowBox)
            listBox.append(row)
        })
    }

    const refreshDevices = () => {
        // Power state
        bluetoothctlCmd(["show"]).then(info => {
            powerChanging = true
            powerSwitch.active = info.includes("Powered: yes")
            powerChanging = false
        })

        // Paired devices with connection status
        bluetoothctlCmd(["devices", "Paired"]).then(pairedOut => {
            const paired = parseDevices(pairedOut)
            bluetoothctlCmd(["devices", "Connected"]).then(connOut => {
                const connected = new Set(parseDevices(connOut).map(d => d.address))
                const withState = paired.map(d => ({ ...d, connected: connected.has(d.address) }))
                rebuildDeviceList(devicesGroup.listBox, withState, true)
            })
        })

        // Nearby (not yet paired)
        bluetoothctlCmd(["devices"]).then(allOut => {
            bluetoothctlCmd(["devices", "Paired"]).then(pairedOut => {
                const allDevices = parseDevices(allOut)
                const pairedAddrs = new Set(parseDevices(pairedOut).map(d => d.address))
                const nearby = allDevices.filter(d => !pairedAddrs.has(d.address))
                rebuildDeviceList(nearbyGroup.listBox, nearby, false)
            })
        })
    }

    // Initial load
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        refreshDevices()
        return GLib.SOURCE_REMOVE
    })

    return page
}
