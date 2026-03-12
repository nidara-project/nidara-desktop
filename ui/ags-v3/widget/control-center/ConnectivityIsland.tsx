import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import AstalBattery from "gi://AstalBattery"
import Theme from "../../core/ThemeManager"
import { ACCENT_PALETTE } from "../../core/FluidCrystal"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer from "../common/SquircleContainer"

export default function ConnectivityIsland(gdkmonitor: Gdk.Monitor, topMargin: number = 48) {
    const notifd = AstalNotifd.get_default()
    const network = AstalNetwork.get_default()
    const bluetooth = AstalBluetooth.get_default()
    const battery = AstalBattery.get_default()

    const win = new Gtk.Window({
        name: "cc-connectivity-island-win",
        application: app,
        css_classes: ["control-center-win", "transparent"],
        visible: false,
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, false)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, false)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, topMargin)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 8)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) { }

    const createToggle = (iconName: string, title: string, sub: string, active: boolean, onClick: () => void) => {
        let isActive = active
        let isHovered = false

        const container = new Gtk.Box({
            hexpand: true,
            vexpand: false,
            css_classes: ["cc-toggle-container"],
            height_request: 64
        })

        const da = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: false
        })
        da.set_draw_func((_, cr, w, h) => {
            const accentHex = ACCENT_PALETTE[Theme.accentColor].color
            const accent = {
                r: parseInt(accentHex.slice(1, 3), 16) / 255,
                g: parseInt(accentHex.slice(3, 5), 16) / 255,
                b: parseInt(accentHex.slice(5, 7), 16) / 255
            }
            const neutral = { r: 1, g: 1, b: 1 }

            cr.setSourceRGBA(0, 0, 0, 0); cr.paint()

            const radius = 24
            const border = { r: 1, g: 1, b: 1, a: 0.08 }

            if (isActive) {
                drawSquircle(cr, w, h, undefined, 0.2, false, accent, radius, false, border)
            } else {
                if (isHovered) drawSquircle(cr, w, h, undefined, 0.08, false, neutral, radius, false, border)
            }
        })

        const contentOverlay = new Gtk.Overlay()
        contentOverlay.set_child(da)

        const box = new Gtk.Box({
            spacing: 12,
            css_classes: ["cc-toggle-content"],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            margin_start: 12
        })

        const iconBox = new Gtk.Box({
            css_classes: ["cc-toggle-icon-box"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            width_request: 38, height_request: 38
        })
        const icon = new Gtk.Image({
            icon_name: iconName, pixel_size: 18,
            css_classes: ["cc-toggle-icon"],
            hexpand: true, vexpand: true
        })
        iconBox.append(icon)

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        const l = new Gtk.Label({ label: title, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 18 })
        const sl = new Gtk.Label({ label: sub, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 18 })
        text.append(l); text.append(sl)

        box.append(iconBox); box.append(text)
        contentOverlay.add_overlay(box)
        container.append(contentOverlay)

        const click = new Gtk.GestureClick()
        click.connect("pressed", () => onClick())
        container.add_controller(click)

        const setActive = (state: boolean) => {
            isActive = state
            da.queue_draw()
            if (state) { l.add_css_class("active-text"); icon.add_css_class("active-icon") }
            else { l.remove_css_class("active-text"); icon.remove_css_class("active-icon") }
        }
            ; (container as any).setActive = setActive

        return { btn: container, icon, label: l, subLabel: sl, setActive }
    }

    const connectivityContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["cc-connectivity-content"],
        margin_top: 16, margin_start: 16, margin_end: 16, margin_bottom: 16,
        width_request: 348
    })

    const connectivityIsland = SquircleContainer({
        child: connectivityContent,
        radius: 32,
        n: 4.5,
        css_classes: ["cc-island", "cc-connectivity-island"],
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.02 },
        inset: 3.0,
        padding: 8
    })

    const statusRow = new Gtk.Box({ spacing: 12, margin_bottom: 4 })
    const battIcon = new Gtk.Image({ icon_name: "battery-level-100-charged-symbolic", pixel_size: 14 })
    const battLabel = new Gtk.Label({ label: "100%" })
    statusRow.append(battIcon); statusRow.append(battLabel)
    connectivityContent.append(statusRow)

    if (battery && battery.is_present) {
        const updateBatt = () => {
            battIcon.icon_name = battery.battery_icon_name
            battLabel.label = `${Math.floor(battery.percentage * 100)}%`
        }
        battery.connect("notify::percentage", updateBatt)
        updateBatt()
    } else { statusRow.visible = false }

    const grid = new Gtk.Grid({ column_spacing: 12, row_spacing: 12, column_homogeneous: true })
    connectivityContent.append(grid)

    const wifiToggle = createToggle("network-wireless-offline-symbolic", "Wi-Fi", "...", false, () => { if (network?.wifi) network.wifi.enabled = !network.wifi.enabled })
    const updateNetwork = () => {
        let icon = "network-wireless-offline-symbolic"; let active = false
        if (network?.primary === AstalNetwork.Primary.WIRED) { icon = network.wired?.icon_name || "network-wired-symbolic"; active = true }
        else if (network?.wifi) { icon = network.wifi.icon_name; active = network.wifi.enabled }
        wifiToggle.icon.icon_name = icon; wifiToggle.setActive(active)
    }
    grid.attach(wifiToggle.btn, 0, 0, 1, 1)
    if (network) network.connect("notify::primary", updateNetwork)
    updateNetwork()

    const btToggle = createToggle("bluetooth-disabled-symbolic", "Bluetooth", "...", false, () => { if (bluetooth) bluetooth.is_powered = !bluetooth.is_powered })
    const updateBT = () => {
        if (!bluetooth) return; const powered = bluetooth.is_powered
        btToggle.icon.icon_name = powered ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"
        btToggle.setActive(powered)
    }
    grid.attach(btToggle.btn, 1, 0, 1, 1)
    if (bluetooth) bluetooth.connect("notify::is-powered", updateBT); updateBT()

    const dndToggle = createToggle("notifications-symbolic", "No molestar", "...", false, () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb })
    const updateDND = () => {
        if (!notifd) return; const state = notifd.dont_disturb
        dndToggle.icon.icon_name = state ? "notifications-disabled-symbolic" : "notifications-symbolic"
        dndToggle.setActive(state)
    }
    grid.attach(dndToggle.btn, 0, 1, 1, 1)
    if (notifd) notifd.connect("notify::dont-disturb", updateDND); updateDND()

    win.set_child(connectivityIsland)

    // @ts-ignore
    win.toggle = () => {
        win.set_visible(!win.get_visible())
    }

    return win
}
