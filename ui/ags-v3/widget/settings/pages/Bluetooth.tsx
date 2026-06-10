import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import GLib from "gi://GLib"
import { listGroup, createRow, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import * as BT from "../../../core/BluetoothService"
import { CrystalButton, showCrystalAlert, type AlertHandle } from "../../../../lib/crystal-ui"

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BluetoothPage() {
    const page = pageBox("bluetooth-page")

    const bt = BT.bt()

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

    // ── Pairing agent ─────────────────────────────────────────────────────────
    // While this page exists, Crystal Shell is the BlueZ pairing agent: passkey
    // confirmations, PIN prompts, and authorization requests surface as alert
    // dialogs. One request at a time (BlueZ serializes them); a new prompt or a
    // BlueZ Cancel() closes whatever is open.
    let activeDialog: AlertHandle | null = null
    let activeDevWatch: (() => void) | null = null

    const closeActiveDialog = () => {
        activeDevWatch?.(); activeDevWatch = null
        const d = activeDialog; activeDialog = null
        d?.close()
    }

    const promptDialog = (p: BT.PairingPrompt) =>
        new Promise<{ ok: boolean; value?: string }>(resolve => {
            closeActiveDialog()

            let body: string, entry: { digitsOnly?: boolean; maxLength?: number } | undefined
            switch (p.kind) {
                case "confirm":
                    body = `${t("settings.bluetooth.pairing.confirm-code")}\n\n${p.code}`
                    break
                case "display":
                    body = `${t("settings.bluetooth.pairing.enter-on-device")}\n\n${p.code}`
                    break
                case "enter-passkey":
                    body = t("settings.bluetooth.pairing.enter-passkey")
                    entry = { digitsOnly: true, maxLength: 6 }
                    break
                case "enter-pin":
                    body = t("settings.bluetooth.pairing.enter-pin")
                    entry = { maxLength: 16 }
                    break
                case "authorize":
                    body = t("settings.bluetooth.pairing.authorize")
                    break
            }

            const root = page.get_root()
            activeDialog = showCrystalAlert({
                parent: root instanceof Gtk.Window && root.visible ? root : null,
                heading: p.deviceName,
                body,
                entry,
                responses: p.kind === "display"
                    ? [{ id: "cancel", label: t("settings.bluetooth.pairing.close") }]
                    : [
                        { id: "cancel", label: t("settings.bluetooth.pairing.cancel") },
                        { id: "ok", label: t("settings.bluetooth.pairing.confirm"), suggested: true },
                    ],
                onResponse: (id, text) => {
                    activeDevWatch?.(); activeDevWatch = null
                    activeDialog = null
                    resolve({ ok: id === "ok", value: text })
                },
            })

            // "Type this code on the device" dialogs have no success reply of their
            // own — auto-close once the device reports paired.
            if (p.kind === "display" && p.device) {
                const dev: any = p.device
                const wid = dev.connect("notify::paired", () => { if (dev.paired) closeActiveDialog() })
                activeDevWatch = () => { try { dev.disconnect(wid) } catch {} }
            }
        })

    BT.registerPairingAgent({ prompt: promptDialog, cancel: closeActiveDialog })

    // ── Power toggle ─────────────────────────────────────────────────────────
    const powerGroup = listGroup(t("settings.bluetooth.title"))
    const powerSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: BT.isPowered(bt) })

    let ignoreStateSet = false
    powerSwitch.connect("state-set", (_: any, state: boolean) => {
        if (ignoreStateSet) return false
        BT.setPowered(state)
        return false
    })

    const syncPower = () => {
        ignoreStateSet = true
        powerSwitch.active = BT.isPowered(bt)
        ignoreStateSet = false
    }
    // The watch is wired once at the end (combined with list/scan visibility),
    // since those groups don't exist yet here.

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
        variant: "secondary",
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
        BT.stopDiscovery()
        scanBtn.sensitive = true
        scanSpinner.stop()
        scanSpinner.visible = false
    }

    scanBtn.connect("clicked", () => {
        scanBtn.sensitive = false
        scanSpinner.visible = true
        scanSpinner.start()
        BT.startDiscovery()
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
                label: BT.deviceName(dev),
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
                // Forget — destructive → danger, matching Network's forget button.
                // Sits to the LEFT of the connect/disconnect action, like the Wi-Fi row.
                const removeBtn = CrystalButton({
                    variant: "danger",
                    pill: true,
                    icon: true,
                    tooltip_text: t("settings.bluetooth.tooltip.forget"),
                })
                removeBtn.set_child(new Gtk.Image({ gicon: Icons.trash, pixel_size: 16, css_classes: ["cs-icon"] }))
                removeBtn.connect("clicked", () => {
                    BT.removeDevice(dev)
                })
                rowBox.append(removeBtn)

                if (dev.connected) {
                    // Disconnect is reversible → neutral (secondary).
                    const disconnectBtn = CrystalButton({
                        label: t("settings.bluetooth.disconnect"),
                        pill: true,
                    })
                    disconnectBtn.connect("clicked", () => {
                        BT.disconnectDevice(dev)
                    })
                    rowBox.append(disconnectBtn)
                } else {
                    const connectBtn = CrystalButton({
                        label: t("settings.bluetooth.connect"),
                        variant: "primary",
                        pill: true,
                    })
                    connectBtn.connect("clicked", () => {
                        BT.connectDevice(dev)
                    })
                    rowBox.append(connectBtn)
                }
            } else {
                const pairBtn = CrystalButton({
                    label: t("settings.bluetooth.pair"),
                    variant: "primary",
                    pill: true,
                })
                pairBtn.connect("clicked", () => {
                    BT.pairDevice(dev)
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
        rebuildList(devicesGroup.listBox, BT.pairedDevices(bt), true)
        rebuildList(nearbyGroup.listBox, BT.nearbyDevices(bt), false)
    }

    const disposeDevices = BT.watchDevices(refreshLists)

    // With the radio off you can't scan or hold a connection, so the device lists
    // and the scan control are meaningless — hide them (and stop any in-flight
    // scan), matching how the adapter actually behaves once powered down.
    const applyPowered = () => {
        const on = BT.isPowered(bt)
        devicesGroup.box.visible = on
        scanGroup.box.visible = on
        nearbyGroup.box.visible = on
        if (!on) stopScan()
    }

    const disposePower = BT.watchPower(() => { syncPower(); applyPowered() })
    page.connect("unrealize", () => {
        disposeDevices()
        disposePower()
        closeActiveDialog()
        BT.unregisterPairingAgent()
    })

    refreshLists()
    applyPowered()

    return page
}
