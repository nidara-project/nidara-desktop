import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { NotificationCapsule } from "./NotificationCenter" // 💎 SYNC

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
        css_classes: ["notif-win", "fc-ignore"],
        child: box
    })

    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) { }

    if (layerInit) {
        try {
            Gtk4LayerShell.set_namespace(win, "notif-win")
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 54)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 12)
            Gtk4LayerShell.set_exclusive_zone(win, 0)
            win.set_default_size(440, -1) // 💎 CONSTRICTION: Prevents horizontal overflow
            // @ts-ignore
            win.gdkmonitor = gdkmonitor
        } catch (e) {
            console.error("[Notif] LayerShell failed:", e)
        }
    }

    const notifMap = new Map<number, Gtk.Widget>()

    const onNotified = (_: any, id: number) => {
        const n = notifd.get_notification(id)
        if (!n) return

        if (notifd.dont_disturb) return

        if (notifMap.has(id)) {
            box.remove(notifMap.get(id)!)
        }

        // 💎 USE IDENTICAL CAPSULE FROM CENTER
        const widget = NotificationCapsule({ n, isPopup: true })
        box.append(widget)
        notifMap.set(id, widget)
        win.set_visible(true)
        win.present()

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
            const w = notifMap.get(id)
            if (w && w.get_parent() === box) {
                box.remove(w)
                notifMap.delete(id)
                if (notifMap.size === 0) win.set_visible(false)
            }
            return GLib.SOURCE_REMOVE
        })
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

    notifd.connect("notified", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onNotified(s, id); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onResolved(s, id); return GLib.SOURCE_REMOVE }))

    return win
}
