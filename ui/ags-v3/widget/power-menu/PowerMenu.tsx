import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

/**
 * Power Menu - Minimalist Session Management 💎
 */
export default function PowerMenu(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "crystal-power-menu",
        css_classes: ["power-menu-win", "fc-ignore"],
        visible: false
    })
    // @ts-ignore
    win.app_paintable = true

    // LayerShell - Fullscreen Overlay
    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "crystal-power-menu") // Critical for Blur
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
    } catch (e) {
        console.error("[Power] LayerShell failed:", e)
    }

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
            win.visible = false
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

    // Close on click outside (ESC handled by GTK automatic if focus is correct)
    const gesture = new Gtk.GestureClick()
    gesture.connect("released", () => { 
        win.set_opacity(0.0)
        win.set_sensitive(false)
    })
    // win.add_controller(gesture) // Maybe too aggressive if clicking buttons? 
    // Usually overlays use ESC or a dedicated "Cancel" btn. 

    const cancelBtn = new Gtk.Button({
        label: "Cancelar",
        css_classes: ["power-cancel-btn"],
        halign: Gtk.Align.CENTER,
        margin_top: 60
    })
    cancelBtn.connect("clicked", () => { 
        win.set_opacity(0.0)
        win.set_sensitive(false)
    })
    mainBox.append(cancelBtn)

    win.child = mainBox

        // Global toggle mechanism
        ; (win as any).toggle = () => {
            console.log("[PowerMenu] Toggle called")
            win.visible = !win.visible
            if (win.visible) {
                updateUptime()
                win.present()
            }
        }

    return win
}
