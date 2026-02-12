import { Gtk } from "ags/gtk4"
import AstalTray from "gi://AstalTray"

export default function Tray() {
    const box = new Gtk.Box({
        css_classes: ["bar-tray"],
        spacing: 8
    })

    const tray = AstalTray.get_default()

    const sync = () => {
        let child = box.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            box.remove(child)
            child = next
        }

        tray.items.forEach(item => {
            const btn = new Gtk.Button({
                css_classes: ["bar-tray-btn"],
                child: new Gtk.Image({
                    gicon: item.gicon,
                    pixel_size: 18
                })
            })
            btn.connect("clicked", () => {
                // GTK4 Popover logic for tray items
                item.about_to_show()
            })
            box.append(btn)
        })
    }

    tray.connect("item-added", sync)
    tray.connect("item-removed", sync)
    sync()

    return box
}
