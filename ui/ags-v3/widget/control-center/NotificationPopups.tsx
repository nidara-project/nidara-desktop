import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { NotificationCapsule } from "./NotificationCenter"
import { dockSideState } from "../../widget/dock/state"

export function NotificationPopupsWidget() {
    const notifd = AstalNotifd.get_default()

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["notif-popup-container"],
        valign: Gtk.Align.START,
        halign: Gtk.Align.END,
        width_request: 440,
        margin_end: dockSideState.position === 'right' ? dockSideState.width : 0,
    })

    dockSideState.subscribe(() => {
        box.margin_end = dockSideState.position === 'right' ? dockSideState.width : 0
    })

    const notifMap = new Map<number, Gtk.Widget>()

    const onNotified = (_: any, id: number) => {
        const n = notifd.get_notification(id)
        if (!n || notifd.dont_disturb) return

        if (notifMap.has(id)) {
            box.remove(notifMap.get(id)!)
        }

        const widget = NotificationCapsule({ n, isPopup: true, onClose: () => {
             if (widget.get_parent() === box) box.remove(widget)
             notifMap.delete(id)
        }})
        box.append(widget)
        notifMap.set(id, widget)

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
            const w = notifMap.get(id)
            if (w && w.get_parent() === box) {
                box.remove(w)
                notifMap.delete(id)
            }
            return GLib.SOURCE_REMOVE
        })
    }

    const onResolved = (_: any, id: number) => {
        const widget = notifMap.get(id)
        if (widget) {
            if (widget.get_parent() === box) box.remove(widget)
            notifMap.delete(id)
        }
    }

    notifd.connect("notified", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onNotified(s, id); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onResolved(s, id); return GLib.SOURCE_REMOVE }))

    return box
}

export default function NotificationPopups(gdkmonitor: Gdk.Monitor) {
    const box = NotificationPopupsWidget()
    const win = new Gtk.Window({
        name: "notif-win",
        application: app,
        css_classes: ["notif-win", "fc-ignore"],
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
        Gtk4LayerShell.set_exclusive_zone(win, 0)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) { }

    return win
}

