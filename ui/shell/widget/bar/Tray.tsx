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
    // Per-item teardown: disconnect EVERY signal handler we attached to the
    // (churny) AstalTray TrayItem when the item goes away. Antigravity re-registers
    // its tray item periodically; leaving `notify::` closures dangling on a TrayItem
    // the library is about to free is what feeds the GParamSpec over-unref that the
    // GC later trips on (g_param_spec_unref UAF → whole-UI segfault ~minutes later).
    const cleanups = new Map<string, () => void>()

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
        const handlerIds: number[] = []
        handlerIds.push(item.connect("notify::gicon", syncIcon))
        handlerIds.push(item.connect("notify::icon-name", syncIcon))

        const btn = new Gtk.Button({
            css_classes: ["bar-tray-btn"],
            tooltip_markup: item.tooltip_markup || item.title || id,
            child: img
        })

        btn.connect("clicked", () => {
            try { item.activate(0, 0) } catch (e) { }
        })

        // LAZY context menu — the DBus menu (appmenu-glib-translator's DbusMenuModel)
        // is only iterated/parsed when the user actually opens it, never at boot.
        //
        // Why: that translator (the crashy `layout_parse`/`get_layout_idle` in the
        // coredump) parses the remote app's menu layout the moment something iterates
        // the model or calls about_to_show(). Doing that eagerly for every item at
        // startup kept a buggy parser live for the whole session, re-parsing each
        // LayoutUpdated — which eventually read a corrupt GVariant length and aborted
        // (g_malloc of ~140 TB). Building on demand shrinks that window to "while the
        // menu is open" and removes the deterministic boot-time g_list_store_remove.
        // Built once, on first right-click, then cached and reused. about_to_show()
        // and model iteration (the two things that kick the buggy translator into
        // parsing) therefore run exactly ONCE per item, on demand — not per open and
        // not at boot. A single items-changed connection (torn down in removeItem)
        // keeps the cached menu fresh; nothing fragile hangs off onClose, so an
        // outside-click dismiss can't leak a connection.
        let menuWrapper: Gtk.Box | null = null
        let menuChangedId = 0
        if (openMenu) {
            const gesture = new Gtk.GestureClick()
            gesture.set_button(3)
            gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            gesture.connect("pressed", (g) => { g.set_state(Gtk.EventSequenceState.CLAIMED) })
            gesture.connect("released", () => {
                const menuModel = item.menu_model
                if (!menuModel) return
                if (!menuWrapper) {
                    const actionGroup = item.action_group
                    const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
                    const onClose = () => { status.bar_expanded_id = "" }
                    const repopulate = () => {
                        let c = wrapper.get_first_child()
                        while (c) { const n = c.get_next_sibling(); wrapper.remove(c); c = n }
                        try { wrapper.append(renderMenuModel(menuModel, actionGroup, onClose)) } catch (e) { }
                    }
                    repopulate()
                    try { menuChangedId = menuModel.connect("items-changed", repopulate) } catch (e) { }
                    try { item.about_to_show() } catch (e) { }   // request layout, ONCE
                    menuWrapper = wrapper
                }
                openMenu(btn, () => menuWrapper!)
            })
            btn.add_controller(gesture)
        }

        cleanups.set(id, () => {
            for (const hid of handlerIds) { try { item.disconnect(hid) } catch (e) { } }
            if (menuChangedId) { try { item.menu_model?.disconnect(menuChangedId) } catch (e) { } }
        })
        items.set(id, btn)
        box.append(btn)
    }

    const removeItem = (id: string) => {
        // Run teardown BEFORE dropping our references so the soon-to-be-freed
        // TrayItem carries none of our dangling closures into finalization.
        const clean = cleanups.get(id)
        if (clean) { clean(); cleanups.delete(id) }

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
