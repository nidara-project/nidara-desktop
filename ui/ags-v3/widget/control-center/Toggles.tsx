import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import { Shape } from "../common/SquircleContainer"
import { AtomicWidget } from "./Types"

export function WifiWidget(grid: { x: number, y: number }): AtomicWidget {
    const network = AstalNetwork.get_default()
    const wifi = network?.wifi

    const icon = new Gtk.Image({
        icon_name: "network-wireless-signal-excellent-symbolic",
        pixel_size: 24
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cc-wifi-widget"]
    })

    const label = new Gtk.Label({ label: "Wi-Fi", css_classes: ["cc-atomic-label-small"] })
    box.append(icon); box.append(label)

    const update = () => {
        if (wifi) icon.icon_name = wifi.icon_name
    }
    if (wifi) wifi.connect("notify::icon-name", update)

    return {
        id: "wifi",
        name: "Wi-Fi",
        grid: { ...grid, w: 2, h: 2 },
        shape: Shape.SQUIRCLE,
        child: box
    }
}

export function RoundToggle(id: string, name: string, iconName: string, grid: { x: number, y: number }, active: boolean, onClick: () => void): AtomicWidget {
    const btn = new Gtk.Button({
        css_classes: ["cc-atomic-round-btn", active ? "active" : ""],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true
    })
    const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 28 })
    btn.set_child(icon)
    btn.connect("clicked", onClick)

    return {
        id,
        name,
        grid: { ...grid, w: 1, h: 1 },
        shape: Shape.CIRCLE,
        child: btn
    }
}

export function FocusWidget(grid: { x: number, y: number }): AtomicWidget {
    const notifd = AstalNotifd.get_default()
    const btn = new Gtk.Button({
        css_classes: ["cc-atomic-focus-btn"],
        hexpand: true, vexpand: true,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER
    })

    const box = new Gtk.Box({ spacing: 12 })
    const icon = new Gtk.Image({ icon_name: "notifications-symbolic", pixel_size: 18 })
    const label = new Gtk.Label({ label: "Do Not Disturb", css_classes: ["cc-atomic-label-small"] })
    box.append(icon); box.append(label)
    btn.set_child(box)

    btn.connect("clicked", () => {
        if (notifd) notifd.dont_disturb = !notifd.dont_disturb
    })

    const update = () => {
        if (!notifd) return
        icon.icon_name = notifd.dont_disturb ? "notifications-disabled-symbolic" : "notifications-symbolic"
        label.label = notifd.dont_disturb ? "DnD On" : "Do Not Disturb"
    }

    if (notifd) {
        notifd.connect("notify::dont-disturb", update)
        update()
    }

    return {
        id: "focus",
        name: "Focus",
        grid: { ...grid, w: 2, h: 1 },
        shape: Shape.CAPSULE,
        child: btn
    }
}
