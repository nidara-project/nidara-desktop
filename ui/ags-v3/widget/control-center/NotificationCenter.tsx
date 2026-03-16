import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer from "../common/SquircleContainer"
import appService from "../../core/AppService"

export default function NotificationCenter(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()

    const win = new Gtk.Window({
        name: "crystal-notification-center",
        application: app,
        css_classes: ["notification-center-win", "transparent", "fc-ignore"],
        visible: false,
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "notification-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    } catch (e) { }

    const overlay = new Gtk.Overlay({
        css_classes: ["nc-window-root"],
        hexpand: true,
        vexpand: true
    })
    win.set_child(overlay)

    const catcher = new Gtk.Box({ hexpand: true, vexpand: true })
    overlay.set_child(catcher)
    const clickGesture = new Gtk.GestureClick()
    clickGesture.connect("pressed", () => { win.visible = false })
    catcher.add_controller(clickGesture)

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12, // Island spacing
        css_classes: ["notification-center-panel"],
        width_request: 420,
        vexpand: true,
        hexpand: false
    })

    const ncContainer = new Gtk.Box({
        css_classes: ["cc-islands-container"], // Matching CC islands logic
        hexpand: false,
        vexpand: true,
        width_request: 420
    })
    ncContainer.append(contentBox)

    ncContainer.halign = Gtk.Align.END
    ncContainer.valign = Gtk.Align.FILL
    ncContainer.margin_top = 8
    ncContainer.margin_end = 8
    ncContainer.margin_bottom = 8
    ncContainer.margin_start = 8

    overlay.add_overlay(ncContainer)

    /* --- ISLAND 1: Calendar Widget --- */
    const calendar = new Gtk.Calendar({
        hexpand: true,
        css_classes: ["nc-calendar"]
    })

    const calendarIsland = SquircleContainer({
        child: calendar,
        radius: 32,
        n: 4.5,
        gloss: true,
        alpha: 0.15,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-calendar-island"],
        onClick: () => {
            GLib.spawn_command_line_async("gnome-calendar")
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                GLib.spawn_command_line_async("hyprctl dispatch focuswindow class:gnome-calendar || hyprctl dispatch focuswindow class:org.gnome.Calendar")
                return GLib.SOURCE_REMOVE
            })
            win.visible = false
        }
    })
    contentBox.append(calendarIsland)

    /* --- ISLAND 2: Notifications History --- */
    const notifContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 16,
        margin_start: 16,
        margin_end: 16,
        margin_bottom: 16,
        vexpand: true
    })

    const header = new Gtk.Box({ spacing: 12, css_classes: ["nc-header"] })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["nc-title"], hexpand: true, halign: Gtk.Align.START }))
    const clear = new Gtk.Button({ label: "Borrar", css_classes: ["nc-clear-btn"] })
    header.append(clear)
    notifContent.append(header)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        css_classes: ["nc-scroll"]
    })
    notifContent.append(scroll)

    const notifList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["nc-list"],
        halign: Gtk.Align.FILL,
        hexpand: true
    })
    scroll.set_child(notifList)

    const notificationsIsland = SquircleContainer({
        child: notifContent,
        radius: 32,
        n: 4.5,
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-history-island"],
        vexpand: true
    })
    contentBox.append(notificationsIsland)

    const updateNotifs = () => {
        while (notifList.get_first_child()) {
            notifList.get_first_child()?.unparent()
        }

        const notifications = notifd.notifications
        if (notifications.length === 0) {
            notifList.append(new Gtk.Label({
                label: "No hay notificaciones",
                css_classes: ["nc-empty"],
                halign: Gtk.Align.CENTER,
                margin_top: 32
            }))
            return
        }

        notifications.forEach(n => {
            const content = new Gtk.Box({
                spacing: 12,
                margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 12
            })

            const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
            body.append(new Gtk.Label({ label: n.summary, css_classes: ["nc-item-title"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3 }))
            body.append(new Gtk.Label({ label: n.body, css_classes: ["nc-item-body"], halign: Gtk.Align.START, xalign: 0, wrap: true, lines: 2, ellipsize: 3 }))

            content.append(body)

            const item = SquircleContainer({
                child: content,
                radius: 16,
                alpha: 0.1, // Double-layered glass look
                borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
            })
            notifList.append(item)
        })
    }

    clear.connect("clicked", () => {
        notifd.notifications.forEach(n => n.dismiss())
    })

    notifd.connect("notified", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    updateNotifs()

    // @ts-ignore
    win.toggle = () => {
        win.visible = !win.visible
        if (win.visible) win.present()
    }

    return win
}
