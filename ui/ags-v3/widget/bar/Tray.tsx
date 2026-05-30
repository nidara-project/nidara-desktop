import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"
import { getServiceSafe } from "../../utils"
import { renderMenuModel } from "../common/CrystalMenu"
import status from "../../core/Status"

// openMenu: opens arbitrary content in the bar's shared expansion capsule, anchored
// under the given widget (same system as the bar widget popovers). Injected by Bar.
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget) => void

export default function Tray(openMenu?: OpenMenu) {
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

        btn.connect("clicked", () => {
            try { item.activate(0, 0) } catch (e) { }
        })

        // Build the context menu ONCE, now, while the tray item + its DBus menu
        // model are valid. We then reuse this prebuilt Gtk.Box on every open and
        // NEVER touch the tray/DBus stack again at open time.
        //
        // Why: the tray item (e.g. Antigravity) re-registers every few seconds,
        // which corrupts an internal GListStore (the recurring g_list_store_remove
        // warning). Re-introspecting the menu model on each open then dereferenced a
        // freed object → g_atomic_ref_count_inc UAF → whole-UI segfault. The native
        // PopoverMenu was stable precisely because it bound the model a single time.
        // Rendering once and reusing the box reproduces that stability.
        const menuModel = item.menu_model
        const actionGroup = item.action_group
        if (menuModel && openMenu) {
            const onClose = () => { status.bar_expanded_id = "" }
            let menuBox: Gtk.Widget = renderMenuModel(menuModel, actionGroup, onClose)

            // DBus tray menus are usually populated LAZILY after about_to_show(), so
            // the model is empty at creation. We rebuild the cached box only when the
            // model itself signals a change (a consistent state) — never on open — so
            // the menu fills with real content while the open path never touches the
            // (churny) DBus stack that was causing the use-after-free segfault.
            let changedId = 0
            try {
                changedId = menuModel.connect("items-changed", () => {
                    try { menuBox = renderMenuModel(menuModel, actionGroup, onClose) } catch (e) { }
                })
            } catch (e) { }
            try { item.about_to_show() } catch (e) { }   // once, item is valid here

            const gesture = new Gtk.GestureClick()
            gesture.set_button(3)
            gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            gesture.connect("pressed", (g) => { g.set_state(Gtk.EventSequenceState.CLAIMED) })
            // Secondary-click → show the prebuilt menu in the bar's shared expansion
            // capsule. CAPTURE + claiming keeps the event from reaching the overlay
            // catcher (which would otherwise dismiss the menu as it opens).
            gesture.connect("released", () => { openMenu(btn, () => menuBox) })
            btn.add_controller(gesture)

            btn.connect("unrealize", () => { if (changedId) try { menuModel.disconnect(changedId) } catch (e) { } })
        }

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
