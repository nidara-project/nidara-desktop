import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"

function Notification(n: any) {
    const box = new Gtk.Box({
        css_classes: ["notif-card"],
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        valign: Gtk.Align.START
    })

    const header = new Gtk.Box({
        spacing: 8,
        valign: Gtk.Align.CENTER
    })

    if (n.app_icon || n.desktop_entry) {
        const icon = new Gtk.Image({
            icon_name: n.app_icon || n.desktop_entry,
            pixel_size: 24
        })
        header.append(icon)
    }

    const appLabel = new Gtk.Label({
        label: n.app_name || "Notification",
        css_classes: ["notif-app-name"],
        halign: Gtk.Align.START,
        hexpand: true,
        ellipsize: 3,
        lines: 1
    })
    header.append(appLabel)

    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
        css_classes: ["notif-close-btn"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })
    closeBtn.connect("clicked", () => n.dismiss())
    header.append(closeBtn)

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        valign: Gtk.Align.START
    })

    const summary = new Gtk.Label({
        label: n.summary,
        css_classes: ["notif-summary"],
        halign: Gtk.Align.START,
        wrap: true,
        lines: 1,
        ellipsize: 3,
        max_width_chars: 30
    })

    const body = new Gtk.Label({
        label: n.body,
        css_classes: ["notif-body"],
        halign: Gtk.Align.START,
        wrap: true,
        lines: 3,
        ellipsize: 3,
        max_width_chars: 42
    })

    content.append(summary)
    content.append(body)

    box.append(header)
    box.append(content)

    return box
}

export default function NotificationPopups(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["notif-popup-container"]
    })

    const win = new Gtk.Window({
        name: "notif-win",
        application: app,
        css_classes: ["notif-win"],
        child: box
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "notif-win")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 54)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 12)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) {
        console.error("[Notif] LayerShell failed:", e)
    }

    const notifMap = new Map<number, Gtk.Widget>()

    const onNotified = (_: any, id: number) => {
        const n = notifd.get_notification(id)
        if (!n) return

        // Remove existing if any (re-notified)
        if (notifMap.has(id)) {
            box.remove(notifMap.get(id)!)
        }

        const widget = Notification(n)
        box.append(widget)
        notifMap.set(id, widget)
        win.set_visible(true)
        win.present()

        // Auto remove from popups after 6s (history stays in NotificationCenter)
        setTimeout(() => {
            const w = notifMap.get(id)
            if (w) {
                box.remove(w)
                notifMap.delete(id)
                if (notifMap.size === 0) win.set_visible(false)
            }
        }, 6000)
    }

    const onResolved = (_: any, id: number) => {
        const widget = notifMap.get(id)
        if (widget) {
            box.remove(widget)
            notifMap.delete(id)
            if (notifMap.size === 0) {
                win.set_visible(false)
            }
        }
    }

    notifd.connect("notified", onNotified)
    notifd.connect("resolved", onResolved)

    return win
}
