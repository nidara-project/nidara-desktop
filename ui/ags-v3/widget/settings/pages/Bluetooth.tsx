import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import GLib from "gi://GLib"
import { listGroup, createRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { CrystalButton } from "../../../../lib/crystal-ui"

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BluetoothPage() {
    const page = pageBox("bluetooth-page")
    page.append(pageHeader(
        t("settings.bluetooth.title"),
        t("settings.bluetooth.subtitle"),
    ))

    const bt = AstalBluetooth.get_default()

    if (!bt || !bt.adapter) {
        const banner = new Gtk.Label({
            label: t("settings.bluetooth.error.no-adapter"),
            css_classes: ["settings-placeholder"],
            margin_top: 24,
            halign: Gtk.Align.CENTER,
        })
        page.append(banner)
        return page
    }

    // ── Power toggle ─────────────────────────────────────────────────────────
    const powerGroup = listGroup(t("settings.bluetooth.title"))
    const powerSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: bt.is_powered })

    let ignoreStateSet = false
    powerSwitch.connect("state-set", (_: any, state: boolean) => {
        if (ignoreStateSet) return false
        bt.is_powered = state
        return false
    })

    const syncPower = () => {
        ignoreStateSet = true
        powerSwitch.active = bt.is_powered
        ignoreStateSet = false
    }

    const powerId = bt.connect("notify::is-powered", syncPower)
    powerSwitch.connect("unrealize", () => { try { bt.disconnect(powerId) } catch {} })

    powerGroup.listBox.append(createRow(
        t("settings.bluetooth.enable"),
        t("settings.bluetooth.enable.desc"),
        powerSwitch,
    ))
    page.append(powerGroup.box)

    // ── Paired devices ────────────────────────────────────────────────────────
    const devicesGroup = listGroup(t("settings.bluetooth.group.paired"))
    page.append(devicesGroup.box)

    // ── Scan ─────────────────────────────────────────────────────────────────
    const scanGroup = listGroup(t("settings.bluetooth.group.search"))
    const scanBtn = CrystalButton({
        label: t("settings.bluetooth.search-now"),
        variant: "primary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    const scanSpinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER, visible: false })
    const scanBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    scanBox.append(scanSpinner)
    scanBox.append(scanBtn)

    let scanTimerId: number | null = null

    const stopScan = () => {
        if (scanTimerId !== null) { GLib.source_remove(scanTimerId); scanTimerId = null }
        try { bt.adapter.stop_discovery() } catch {}
        scanBtn.sensitive = true
        scanSpinner.stop()
        scanSpinner.visible = false
    }

    scanBtn.connect("clicked", () => {
        scanBtn.sensitive = false
        scanSpinner.visible = true
        scanSpinner.start()
        try { bt.adapter.start_discovery() } catch {}
        if (scanTimerId !== null) GLib.source_remove(scanTimerId)
        scanTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
            stopScan()
            return GLib.SOURCE_REMOVE
        })
    })
    scanBtn.connect("unrealize", () => stopScan())

    scanGroup.listBox.append(createRow(
        t("settings.bluetooth.scan"),
        t("settings.bluetooth.scan.desc"),
        scanBox,
    ))
    page.append(scanGroup.box)

    // ── Nearby devices list ───────────────────────────────────────────────────
    const nearbyGroup = listGroup(t("settings.bluetooth.group.detected"))
    page.append(nearbyGroup.box)

    // ── Device list builder ───────────────────────────────────────────────────
    const rebuildList = (
        listBox: Gtk.ListBox,
        devices: AstalBluetooth.Device[],
        allowActions: boolean,
    ) => {
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        if (devices.length === 0) {
            const empty = new Gtk.Label({
                label: t("settings.bluetooth.no-devices"),
                css_classes: ["settings-placeholder"],
                margin_top: 12,
                margin_bottom: 12,
            })
            const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
            row.set_child(empty)
            listBox.append(row)
            return
        }

        devices.forEach(dev => {
            const nameLabel = new Gtk.Label({
                label: dev.name || dev.address,
                css_classes: ["crystal-row-title"],
                halign: Gtk.Align.START,
                hexpand: true,
                ellipsize: 3,
            })
            const addrLabel = new Gtk.Label({
                label: dev.address,
                css_classes: ["crystal-row-subtitle"],
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
            const devImg = new Gtk.Image({ pixel_size: 20, valign: Gtk.Align.CENTER, css_classes: ["cs-icon"] })
            if (dev.icon) devImg.icon_name = dev.icon; else devImg.gicon = Icons.bluetooth
            rowBox.append(devImg)
            rowBox.append(textBox)

            if (allowActions) {
                if (dev.connected) {
                    const disconnectBtn = new Gtk.Button({
                        label: t("settings.bluetooth.disconnect"),
                        css_classes: ["crystal-btn"],
                        valign: Gtk.Align.CENTER,
                    })
                    disconnectBtn.connect("clicked", () => {
                        dev.disconnect_device(null)
                    })
                    rowBox.append(disconnectBtn)
                } else {
                    const connectBtn = new Gtk.Button({
                        label: t("settings.bluetooth.connect"),
                        css_classes: ["crystal-btn", "crystal-btn--primary"],
                        valign: Gtk.Align.CENTER,
                    })
                    connectBtn.connect("clicked", () => {
                        dev.connect_device(null)
                    })
                    rowBox.append(connectBtn)
                }

                const removeBtn = new Gtk.Button({
                    child: new Gtk.Image({ gicon: Icons.trash, pixel_size: 16 , css_classes: ["cs-icon"] }),
                    css_classes: ["crystal-btn", "crystal-btn--danger"],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: t("settings.bluetooth.tooltip.forget"),
                })
                removeBtn.connect("clicked", () => {
                    try { bt.adapter.remove_device(dev) } catch {}
                })
                rowBox.append(removeBtn)
            } else {
                const pairBtn = new Gtk.Button({
                    label: t("settings.bluetooth.pair"),
                    css_classes: ["settings-row-action"],
                    valign: Gtk.Align.CENTER,
                })
                pairBtn.connect("clicked", () => {
                    try { dev.pair() } catch (e) { console.error("[BT] pair:", e) }
                })
                rowBox.append(pairBtn)
            }

            const row = new Gtk.ListBoxRow({ css_classes: ["crystal-row"] })
            row.set_child(rowBox)
            listBox.append(row)
        })
    }

    // ── Live device updates ───────────────────────────────────────────────────
    const refreshLists = () => {
        const all: AstalBluetooth.Device[] = bt.devices ?? []
        const paired = all.filter(d => d.paired)
        const unpaired = all.filter(d => !d.paired)
        rebuildList(devicesGroup.listBox, paired, true)
        rebuildList(nearbyGroup.listBox, unpaired, false)
    }

    const devicesId = bt.connect("notify::devices", refreshLists)
    page.connect("unrealize", () => { try { bt.disconnect(devicesId) } catch {} })

    refreshLists()

    return page
}
