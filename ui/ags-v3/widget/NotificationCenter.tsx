import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"

function NotificationItem(n: AstalNotifd.Notification) {
    const box = new Gtk.Box({
        css_classes: ["nc-notif-item"],
        spacing: 12,
        valign: Gtk.Align.START
    })

    const iconBox = new Gtk.Box({
        css_classes: ["nc-notif-icon-box"],
        valign: Gtk.Align.START
    })
    const icon = new Gtk.Image({
        icon_name: n.app_icon || n.desktop_entry || "dialog-information-symbolic",
        pixel_size: 24
    })
    iconBox.append(icon)

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        valign: Gtk.Align.START
    })
    const title = new Gtk.Label({
        label: n.summary,
        css_classes: ["nc-notif-title"],
        halign: Gtk.Align.START,
        ellipsize: 3,
        lines: 1
    })
    const body = new Gtk.Label({
        label: n.body,
        css_classes: ["nc-notif-body"],
        halign: Gtk.Align.START,
        wrap: true,
        lines: 2,
        ellipsize: 3,
        max_width_chars: 42
    })

    content.append(title)
    content.append(body)

    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
        css_classes: ["nc-notif-close"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })
    closeBtn.connect("clicked", () => n.dismiss())

    box.append(iconBox)
    box.append(content)
    box.append(closeBtn)

    return box
}

export default function NotificationCenter(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()

    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["notification-center"]
    })

    const header = new Gtk.Box({ css_classes: ["nc-header"], spacing: 12 })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["nc-header-title"], hexpand: true, halign: Gtk.Align.START }))

    const dndBox = new Gtk.Box({ spacing: 8, css_classes: ["nc-dnd-box"] })
    const dndLabel = new Gtk.Label({ label: "No molestar", css_classes: ["nc-dnd-label"] })
    const dndSwitch = new Gtk.Switch({
        active: notifd.dont_disturb,
        valign: Gtk.Align.CENTER,
        css_classes: ["nc-dnd-switch"]
    })
    dndSwitch.connect("state-set", (_, state) => {
        notifd.dont_disturb = state
        return false // let the property notify handle it or handle it manually
    })
    dndBox.append(dndLabel)
    dndBox.append(dndSwitch)

    const clearBtn = new Gtk.Button({ label: "Borrar todo", css_classes: ["nc-clear-btn"] })
    clearBtn.connect("clicked", () => {
        notifd.notifications.forEach(n => n.dismiss())
    })

    header.append(dndBox)
    header.append(clearBtn)

    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        child: list,
        css_classes: ["nc-scroll"]
    })

    const history = new Map<number, AstalNotifd.Notification>()

    const sync = () => {
        let child = list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            list.remove(child)
            child = next
        }

        // Convert map values to array and sort by ID (newer first)
        const all = Array.from(history.values()).sort((a, b) => b.id - a.id)

        all.forEach(n => {
            list.append(NotificationItem(n))
        })

        if (all.length === 0) {
            list.append(new Gtk.Label({ label: "No hay notificaciones nuevas", css_classes: ["nc-empty"], vexpand: true, valign: Gtk.Align.CENTER }))
        }
    }

    notifd.connect("notified", (_, id) => {
        const n = notifd.get_notification(id)
        if (n) {
            history.set(id, n)
            sync()
        }
    })

    // On resolved, we DON'T remove from history, unless it was dismissed by user?
    // Actually, let's just keep them all until "Borrar todo"
    // notifd.connect("resolved", sync) // Removed!

    clearBtn.connect("clicked", () => {
        history.clear()
        notifd.notifications.forEach(n => n.dismiss())
        sync()
    })

    // Initial sync with whatever is active now
    notifd.notifications.forEach(n => history.set(n.id, n))
    sync()

    container.append(header)
    container.append(scroll)

    const win = new Gtk.Window({
        name: "notification-center-win",
        application: app,
        css_classes: ["notification-center-win"],
        child: container,
        visible: false
    })

    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) { }

    if (layerInit) {
        try {
            Gtk4LayerShell.set_namespace(win, "notification-center")
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 54)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 12)
            // @ts-ignore
            win.gdkmonitor = gdkmonitor
        } catch (e) {
            console.error("[NC] LayerShell failed:", e)
        }
    }

    // @ts-ignore
    win.toggle = () => {
        sync() // Force sync on toggle
        win.set_visible(!win.get_visible())
        if (win.get_visible()) win.present()
    }

    return win
}
