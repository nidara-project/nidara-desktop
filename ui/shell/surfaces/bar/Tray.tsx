import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalTray from "gi://AstalTray"
import { getServiceSafe } from "../../utils"
import { renderMenuModel } from "../../common/NidaraMenu"
import status from "../../core/Status"
import { safeDisconnect } from "../../core/signals"
import { attachTooltip } from "../../common/Tooltip"
import SquircleContainer from "../../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import hs from "../../core/HyprlandState"

// openMenu: opens arbitrary content in the bar's shared expansion capsule, anchored
// under the given widget (same system as the bar widget popovers). Injected by Bar.
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

export default function Tray(openMenu?: OpenMenu) {
    // Spacing container only — each tray item now carries its OWN glass capsule
    // (see createItem), so there's no outer grouping pill and no interior padding
    // here. 8px matches the gap between the other right-side bar capsules.
    const box = new Gtk.Box({
        name: "bar-tray",
        css_classes: ["bar-tray"],
        spacing: 8,
    })

    // id → the item's top-level capsule (the child appended to `box`). We keep the
    // capsule (not the raw button) so removeItem detaches the whole thing.
    const items = new Map<string, Gtk.Widget>()
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

        // 16px air each side → the button (and thus its capsule) is 48px wide,
        // matching the search / CC / clock icon capsules exactly.
        const img = new Gtk.Image({ pixel_size: 16, css_classes: ["bar-tray-icon"], margin_start: 16, margin_end: 16 })

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
            child: img
        })
        // Glass tooltip (markup — SNI items expose tooltip_markup); read lazily so
        // it tracks the item's live title/tooltip without a subscription. Position
        // BOTTOM: the tray sits in the top bar, so the bubble drops below and its
        // pointer aims up at the icon (and GTK won't auto-flip it).
        attachTooltip(btn, () => item.tooltip_markup || item.title || id, { markup: true, position: Gtk.PositionType.BOTTOM })

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
        // Built once, on first open, then cached and reused. about_to_show()
        // and model iteration (the two things that kick the buggy translator into
        // parsing) therefore run exactly ONCE per item, on demand — not per open and
        // not at boot. A single items-changed connection (torn down in removeItem)
        // keeps the cached menu fresh; nothing fragile hangs off onClose, so an
        // outside-click dismiss can't leak a connection.
        let menuWrapper: Gtk.Box | null = null
        let menuChangedId = 0
        const showContextMenu = () => {
            if (!openMenu) return
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
            openMenu!(btn, () => menuWrapper!)
        }

        // Left click → activate the app. But items flagged is_menu have NO activate
        // action (AstalTray docstring: "only supports the menu, so showing the menu
        // should be preferred over calling activate") — most Electron / libappindicator
        // trays are like this, so activate(0,0) is a silent no-op. For those, left-click
        // opens the menu instead of doing nothing.
        // Resolve the PID that owns this item's DBus connection — the STRONGEST link
        // between a tray item and its Wayland window (SNI carries no window handle).
        // item_id is "<busname>/<objectpath>"; the bus name owns the SNI connection,
        // and Hyprland exposes each window's pid, so equal PIDs = same app process.
        // Resolved async once and cached; a click before it resolves just falls
        // through to the name heuristic below. Re-resolved for free when an app
        // re-registers its item (that path builds a fresh item → fresh createItem).
        let itemPid = 0
        const busName = String(item.item_id || "").split("/")[0]
        if (busName.startsWith(":")) {
            try {
                Gio.DBus.session.call(
                    "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                    "GetConnectionUnixProcessID", new GLib.Variant("(s)", [busName]),
                    new GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, null,
                    (_src, res) => {
                        try { itemPid = Gio.DBus.session.call_finish(res).deep_unpack()[0] as number } catch (e) { }
                    },
                )
            } catch (e) { }
        }

        // Find this item's toplevel window and raise it, best link first:
        //   1) PID — deterministic when the app registers its own tray (Telegram,
        //      Electron, most native apps). Misses only proxied/legacy X11 icons,
        //      where the bus name belongs to the proxy, not the app.
        //   2) Name heuristic — normalise the item's id / icon_name / title AND the
        //      window class to bare alphanumerics, accept when one contains the other
        //      (icon "org.telegram.desktop-attention-symbolic" ⊇ class
        //      "org.telegram.desktop"; id "Antigravity_status_icon_1" ⊇ "antigravity").
        const norm = (s: any) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
        const focusAppWindow = (): boolean => {
            if (itemPid > 0) {
                const byPid = hs.clients.find(c => c.pid === itemPid)
                if (byPid) { hs.focusWindow(byPid.address); return true }
            }
            const cands = [item.id, item.icon_name, item.title].map(norm).filter(c => c.length >= 3)
            if (cands.length === 0) return false
            for (const c of hs.clients) {
                const w = norm(c.class)
                if (w.length < 3) continue
                if (cands.some(cand => cand.includes(w) || w.includes(cand))) {
                    hs.focusWindow(c.address)
                    return true
                }
            }
            return false
        }

        // Left click. SNI "Activate" nominally means "show/raise your window", but a
        // Wayland client can't focus itself or pull the user to its workspace — the
        // compositor blocks self-activation — so for an app whose window is merely
        // parked on another workspace, activate() succeeds yet nothing visibly happens
        // (verified: Telegram/Antigravity both hit this). Nidara IS the compositor's
        // shell, so it does the raise itself: focus the matched window (switching
        // workspace). Only when NO window matches — the app is truly minimised to the
        // tray with no surface — fall back to activate() so it can restore its window.
        btn.connect("clicked", () => {
            if (item.is_menu) { showContextMenu(); return }
            if (focusAppWindow()) return
            try { item.activate(0, 0) } catch (e) { }
        })

        // Right click → always the context menu (built on demand, cached above).
        if (openMenu) {
            const gesture = new Gtk.GestureClick()
            gesture.set_button(3)
            gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            gesture.connect("pressed", (g) => { g.set_state(Gtk.EventSequenceState.CLAIMED) })
            gesture.connect("released", () => { showContextMenu() })
            btn.add_controller(gesture)
        }

        cleanups.set(id, () => {
            for (const hid of handlerIds) safeDisconnect(item, hid)
            if (menuChangedId) safeDisconnect(item.menu_model, menuChangedId)
        })
        // Wrap each item in its own glass capsule — identical construction to the
        // search / CC / clock capsules, so tray icons read as first-class bar icons
        // rather than one grouped pill. The button fills the 48px capsule, so the
        // whole capsule left-clicks (activate) and right-clicks (menu); the
        // SquircleContainer only paints the glass + hover-accent border.
        const capsule = SquircleContainer({
            child: btn, gloss: true, useShellOpacity: true, chrome: true,
            opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true,
        })
        items.set(id, capsule)
        box.append(capsule)
    }

    const removeItem = (id: string) => {
        // Run teardown BEFORE dropping our references so the soon-to-be-freed
        // TrayItem carries none of our dangling closures into finalization.
        const clean = cleanups.get(id)
        if (clean) { clean(); cleanups.delete(id) }

        const capsule = items.get(id)
        if (capsule) {
            try {
                if (capsule.get_parent() === box) box.remove(capsule)
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
