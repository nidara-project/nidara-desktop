import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import status from "../../core/Status"

import SquircleContainer, { Shape } from "../common/SquircleContainer"

/**
 * Power Menu - Minimalist Session Management 💎
 */
export default function PowerMenu() {
    const userName = GLib.get_user_name()
    const header = new Gtk.Label({
        label: `Goodbye, ${userName.charAt(0).toUpperCase() + userName.slice(1)}`,
        css_classes: ["power-header"]
    })

    const uptimeLabel = new Gtk.Label({
        label: "System Uptime: ...",
        css_classes: ["power-uptime"]
    })

    const updateUptime = () => {
        execAsync(["uptime", "-p"]).then(out => {
            uptimeLabel.label = out.trim().replace("up ", "System Uptime: ")
        }).catch(() => uptimeLabel.label = "System Uptime: Unknown")
    }

    const actions = [
        { icon: "system-shutdown-symbolic", label: "Apagar", cmd: "shutdown now", class: "shutdown" },
        { icon: "system-reboot-symbolic", label: "Reiniciar", cmd: "reboot", class: "reboot" },
        { icon: "system-suspend-symbolic", label: "Suspender", cmd: "systemctl suspend", class: "suspend" },
        { icon: "system-log-out-symbolic", label: "Cerrar Sesión", cmd: "hyprctl dispatch exit", class: "logout" },
        { icon: "changes-prevent-symbolic", label: "Bloquear", cmd: "hyprlock", class: "lock" },
    ]

    const actionBox = new Gtk.Box({
        spacing: 24,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        css_classes: ["power-action-box"]
    })

    actions.forEach(a => {
        const icon = new Gtk.Image({ icon_name: a.icon, pixel_size: 32 })
        const label = new Gtk.Label({ label: a.label, css_classes: ["power-btn-label"] })
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8
        })
        box.append(icon)
        box.append(label)

        const btn = new Gtk.Button({
            child: box,
            css_classes: ["power-btn", a.class],
            hexpand: false,
            vexpand: false
        })

        btn.connect("clicked", () => {
            status.power_menu_open = false
            execAsync(["bash", "-c", a.cmd]).catch(console.error)
        })

        actionBox.append(btn)
    })

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 40,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        css_classes: ["power-main-box"]
    })

    mainBox.append(header)
    mainBox.append(actionBox)
    mainBox.append(uptimeLabel)

    const cancelBtn = new Gtk.Button({
        label: "Cancelar",
        css_classes: ["power-cancel-btn"],
        halign: Gtk.Align.CENTER,
        margin_top: 60
    })
    cancelBtn.connect("clicked", () => { 
        status.power_menu_open = false
    })
    mainBox.append(cancelBtn)

    // Update uptime when it becomes visible
    status.connect("notify::power-menu-open", () => {
        if (status.power_menu_open) {
            updateUptime()
        }
    })

    return SquircleContainer({ 
        child: mainBox, 
        n: 3.2, 
        radius: 32,
        alpha: 0.15, 
        gloss: true, 
        borderColor: { r: 1, g: 1, b: 1, a: 0.1 }
    })
}
