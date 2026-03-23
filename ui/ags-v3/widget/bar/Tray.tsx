import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"
import { getServiceSafe } from "../../utils"

/**
 * System Tray Module 📥
 * High-fidelity implementation with PopoverMenu and robust sync.
 */
export default function Tray() {
    const box = new Gtk.Box({
        name: "bar-tray",
        css_classes: ["bar-tray"],
        spacing: 8,
        height_request: 24,
        margin_start: 16, // Unified 16px 📐
        margin_end: 16,
        margin_top: 4,
        margin_bottom: 4
    })

    const items = new Map<string, Gtk.Button>()

    const createItem = (tray: any, id: string) => {
        if (items.has(id)) return;

        const item = tray.items.find((i: any) => i.item_id === id)
        if (!item) return;

        // Strict Visibility Check: only items with Icons or Titles
        if (!item.gicon && (!item.icon_name || item.icon_name.length === 0) && !item.title) return;

        const btn = new Gtk.Button({
            css_classes: ["bar-tray-btn"],
            tooltip_markup: item.tooltip_markup || item.title || id,
            child: new Gtk.Image({
                pixel_size: 16,
                css_classes: ["bar-tray-icon"],
                gicon: item.gicon,
                icon_name: item.icon_name
            })
        })

        // Context Menu Support 🖱️
        let menu: Gtk.PopoverMenu | null = null
        if (item.menu_model) {
            menu = new Gtk.PopoverMenu({
                menu_model: item.menu_model,
                autohide: true,
                has_arrow: false,
                css_classes: ["bar-tray-menu"]
            })
            menu.set_parent(btn)
            if (item.action_group) {
                btn.insert_action_group("dbusmenu", item.action_group)
            }
        }

        btn.connect("clicked", () => {
            try { item.activate(0, 0) } catch (e) { }
        })

        const gesture = new Gtk.GestureClick()
        gesture.set_button(0)
        gesture.connect("released", (g) => {
            const b = g.get_current_button()
            if (b === 3) { // Right Click
                try { item.about_to_show() } catch (e) { }
                if (menu) menu.popup()
            }
        })
        btn.add_controller(gesture)

        items.set(id, btn)
        box.append(btn)
    }

    const removeItem = (id: string) => {
        const btn = items.get(id)
        if (btn) {
            try {
                if (btn.get_parent() === box) box.remove(btn)
            } catch (e) { }
            items.delete(id)
        }
    }

    // Sync Tray Mechanism 📥
    getServiceSafe(() => AstalTray.get_default(), "Tray").then(tray => {
        if (!tray) return;

        const syncVisibility = () => box.set_visible(items.size > 0)

        const addItem = (id: string) => {
            if (!id || items.has(id)) return
            createItem(tray, id)
            syncVisibility()
        }

        const delItem = (id: string) => {
            if (!id) return
            removeItem(id)
            syncVisibility()
        }

        tray.connect("item-added", (_, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { addItem(id); return GLib.SOURCE_REMOVE }))
        tray.connect("item-removed", (_, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { delItem(id); return GLib.SOURCE_REMOVE }))

        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            try {
                const current = tray.items || []
                current.forEach(item => {
                    if (item && item.item_id) addItem(item.item_id)
                })
            } catch (e) { }
            syncVisibility()
            return GLib.SOURCE_REMOVE
        })
    })

    box.set_visible(false) // Start hidden
    return box
}
