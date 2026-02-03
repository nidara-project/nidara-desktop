import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"

function Notification(n: AstalNotifd.Notification) {
    const box = new Gtk.Box({
        css_classes: ["notif-card"],
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8
    })

    const header = new Gtk.Box({ spacing: 8 })

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
        hexpand: true
    })
    header.append(appLabel)

    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
        css_classes: ["notif-close-btn"]
    })
    closeBtn.connect("clicked", () => n.dismiss())
    header.append(closeBtn)

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4
    })

    const summary = new Gtk.Label({
        label: n.summary,
        css_classes: ["notif-summary"],
        halign: Gtk.Align.START,
        wrap: true,
        max_width_chars: 30
    })

    const body = new Gtk.Label({
        label: n.body,
        css_classes: ["notif-body"],
        halign: Gtk.Align.START,
        wrap: true,
        max_width_chars: 40
    })

    content.append(summary)
    content.append(body)

    box.append(header)
    box.append(content)

    // Auto dismiss after 5s
    setTimeout(() => n.dismiss(), 5000)

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

        const widget = Notification(n)
        box.append(widget)
        notifMap.set(id, widget)
        win.present()
    }

    const onResolved = (_: any, id: number) => {
        const widget = notifMap.get(id)
        if (widget) {
            box.remove(widget)
            notifMap.delete(id)
            if (notifMap.size === 0) {
                // Should we hide window? Gtk4LayerShell might feel weird if we hide/show too much
            }
        }
    }

    notifd.connect("notified", onNotified)
    notifd.connect("resolved", onResolved)

    return win
}
