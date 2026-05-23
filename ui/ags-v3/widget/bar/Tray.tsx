import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"
import { getServiceSafe } from "../../utils"

export default function Tray() {
    const box = new Gtk.Box({
        name: "bar-tray",
        css_classes: ["bar-tray"],
        spacing: 8,
        height_request: 24,
        margin_start: 16,
        margin_end: 16,
        margin_top: 4,
        margin_bottom: 4
    })

    const items = new Map<string, Gtk.Button>()

    const createItem = (tray: any, id: string) => {
        if (items.has(id)) return;

        const item = tray.items.find((i: any) => i.item_id === id)
        if (!item) return;

        if (!item.gicon && (!item.icon_name || item.icon_name.length === 0) && !item.title) return;

        // Add custom icon theme path before resolving any icon_name so that apps
        // that ship their own icon set (e.g. Antigravity) are findable by GTK.
        if (item.icon_theme_path) {
            try {
                const display = Gdk.Display.get_default()
                if (display) {
                    const theme = Gtk.IconTheme.get_for_display(display)
                    const paths: string[] = theme.get_search_path() ?? []
                    if (!paths.includes(item.icon_theme_path))
                        theme.add_search_path(item.icon_theme_path)
                }
            } catch (_) {}
        }

        const img = new Gtk.Image({ pixel_size: 16, css_classes: ["bar-tray-icon"] })

        // Use icon_name when the active icon theme knows the icon (or its -symbolic
        // variant). CSS `-gtk-icon-style: symbolic` then makes GTK prefer the
        // *-symbolic version automatically and recolor it via the `color` property.
        // Fall back to gicon (AstalTray's composed icon) for apps without a
        // recognized name in the current theme (e.g. apps that only send a pixmap).
        const displayTheme = (() => {
            try { return Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!) } catch { return null }
        })()
        const syncIcon = () => {
            const name = item.icon_name
            // Only look for *-symbolic explicitly. has_icon() traverses the full
            // inheritance chain (including hicolor) so regular icons like steam.png
            // would match, then CSS -gtk-icon-style:symbolic would force them white.
            // If no symbolic exists, use gicon (the app's raw composited icon).
            if (name && displayTheme) {
                const sym = name.endsWith("-symbolic") ? name : name + "-symbolic"
                if (displayTheme.has_icon(sym)) {
                    img.set_from_icon_name(sym)
                    return
                }
            }
            if (item.gicon) { img.set_from_gicon(item.gicon); return }
            if (name)        { img.set_from_icon_name(name) }
        }
        syncIcon()
        item.connect("notify::gicon", syncIcon)
        item.connect("notify::icon-name", syncIcon)

        const btn = new Gtk.Button({
            css_classes: ["bar-tray-btn"],
            tooltip_markup: item.tooltip_markup || item.title || id,
            child: img
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
