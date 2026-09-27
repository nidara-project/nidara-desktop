import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { getDefault as getTray } from "../../core/tray"
import { getServiceSafe } from "../../utils"
import { renderMenuModel } from "../../common/NidaraMenu"
import status from "../../core/Status"
import { safeDisconnect } from "../../core/signals"
import { barItem, barOpen, barTooltip, isBarCustomAnchor } from "./capsule"
import hs from "../../core/HyprlandState"
import { BAR_ICON_SIZE, BAR_ITEM_PAD } from "../../common/widget-kit"
import { rememberTrayItem, trayKey } from "../../core/BarOrder"
import appService from "../../core/AppService"

// ── Which APP owns a tray icon ────────────────────────────────────────────────
// An SNI item names itself with `Id` and `Title`, and Electron apps do it badly:
// Chromium registers `<app>_status_icon_<n>` with an EMPTY title — and when the app
// sets no name, `<app>` is `chrome`. Measured 2026-09-26: the ChatGPT desktop app is
// `chrome_status_icon_1`, title "", no icon name; Claude Desktop `Claude_status_icon_1`,
// title "". Shown raw, Settings listed "chrome_status_icon_1" and the owner took it for
// Chrome (which puts no icon in the tray at all without background apps). And as a KEY
// it is not an identity: any other nameless Electron app registers the same Id.
//
// So when the item does not say who it is, ask the process that owns it: its
// executable, matched against the installed apps, gives the name and icon a person
// knows it by — and, for the generic Chromium Id, the key.
const GENERIC_SNI_ID = /^chrome_status_icon_\d+$/
const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

/** The PID that owns an SNI bus name. Chromium and KDE put it IN the well-known name
 *  (`org.freedesktop.StatusNotifierItem-<pid>-<n>`); otherwise ask the bus, once. */
function ownerPid(busName: string): number {
    const m = /StatusNotifierItem-(\d+)-\d+$/.exec(busName)
    if (m) return Number(m[1])
    if (!busName.startsWith(":")) return 0
    try {
        const r = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", new GLib.Variant("(s)", [busName]),
            new GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 500, null)
        return r.deep_unpack()[0] as number
    } catch { return 0 }
}

/** The executable's name (`ChatGPT`, `claude-desktop`): the exe link's basename, or
 *  `comm` (15 chars at most) when the link cannot be read. */
function processName(pid: number): string {
    if (pid <= 0) return ""
    try { return GLib.path_get_basename(GLib.file_read_link(`/proc/${pid}/exe`)) } catch {}
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`)
        if (ok) return new TextDecoder().decode(bytes).trim()
    } catch {}
    return ""
}

/** What Settings should show for a tray icon: the SAME image the bar paints (see
 *  syncIcon), recorded in `tray-known` as an icon name or a file path. An app that sends
 *  only PIXELS (every Electron app) has neither, so its pixbuf is written once to
 *  `~/.cache/nidara/tray-icons/` — the cache, not the config dir: that one is a read root
 *  of the assistant's file layer, the same reason notifd keeps its images there. Before
 *  this, Settings fell back to the APP's icon and showed the dock's glyph for an icon
 *  the bar draws differently (owner-caught 2026-09-26, Claude and Antigravity). */
function recordedTrayIcon(item: any, theme: Gtk.IconTheme | null, sniId: string): string {
    const name: string = item.icon_name || ""
    if (name && theme) {
        const sym = name.endsWith("-symbolic") ? name : name + "-symbolic"
        if (theme.has_icon(sym)) return sym
    }
    const g = item.gicon
    try {
        if (g instanceof Gio.ThemedIcon) return g.get_names()[0] ?? name
        if (g instanceof Gio.FileIcon) return g.get_file().get_path() ?? name
        if (g && typeof g.savev === "function") {   // a GdkPixbuf from the item's pixmaps
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), "nidara", "tray-icons"])
            GLib.mkdir_with_parents(dir, 0o700)
            const path = GLib.build_filenamev([dir, `${sniId.replace(/[^A-Za-z0-9._-]/g, "_")}.png`])
            g.savev(path, "png", [], [])
            return path
        }
    } catch (e) { console.warn(`[Tray] could not record the icon of ${sniId}:`, e) }
    return name
}

/** The installed app a process name belongs to, compared letters-and-digits only
 *  against the app's id, its Exec's command, its WM class and its name
 *  (`ChatGPT` ↔ Exec `…/bin/chatgpt`; `claude-desktop` ↔ Exec `…/bin/claude-desktop`). */
function appForProcess(proc: string): { id: string, name: string, icon: string } | null {
    const want = norm(proc)
    if (want.length < 3) return null
    for (const a of appService.getAllApps()) {
        const cmd = GLib.path_get_basename(String(a.exec ?? "").trim().split(/\s+/)[0] ?? "")
        // `a.id` is ALREADY the desktop id without its `.desktop` — and a name may end in
        // ".desktop" itself: Telegram's file is `org.telegram.desktop.desktop`, and
        // stripping the suffix here once recorded `org.telegram`, which no app answers
        // to, so Settings dropped Telegram as uninstalled (caught live 2026-09-27).
        if ([a.id, cmd, a.wmClass, a.name].some(c => norm(c) === want))
            return { id: a.id, name: a.name, icon: a.rawIcon || a.icon || "" }
    }
    return null
}

// openMenu: opens arbitrary content in the bar's shared expansion capsule, anchored
// under the given widget (same system as the bar widget popovers). Injected by Bar.
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

/** The tray as a SOURCE of bar items, not a box of its own (2026-09-26): the bar places
 *  each icon wherever the right group's order puts it (core/BarOrder.ts), in between the
 *  widgets. An item's widget lives as long as the app's icon does and is re-parented on
 *  every bar rebuild, never rebuilt — it holds the menu, the PID and the subscriptions. */
export interface TraySource {
    /** The live icons' bar keys (`tray:<SNI Id>`), in the order they arrived. */
    keys(): string[]
    widget(key: string): Gtk.Widget | null
}

export default function Tray(openMenu?: OpenMenu, onItemsChanged?: () => void): TraySource {
    // item_id (bus name + path) → the item's bar widget and its bar key. The key is the
    // SNI Id, which survives the app restarting; the item_id does not.
    const items = new Map<string, { widget: Gtk.Widget, key: string }>()
    // Per-item teardown: drop EVERY subscription we took on the (churny) TrayItem
    // when the item goes away. Antigravity re-registers its tray item periodically.
    // Under AstalTray these were `notify::` closures on a GObject the library was
    // about to free, which fed a GParamSpec over-unref the GC tripped on minutes
    // later (whole-UI segfault); `core/tray.ts` items are plain objects with plain
    // callback sets, but they still have to be released or the closures keep the
    // dead item — and this widget — alive.
    const cleanups = new Map<string, () => void>()

    const createItem = (tray: ReturnType<typeof getTray>, id: string) => {
        if (items.has(id)) return;

        const item = tray.getItem(id)
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

        // BAR_ITEM_PAD each side of a BAR_ICON_SIZE icon → the button (and thus its
        // item) is exactly as wide as the search / widget icon items.
        const img = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, css_classes: ["bar-tray-icon"], margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD })

        // Use icon_name when the active icon theme knows the icon (or its -symbolic
        // variant). CSS `-gtk-icon-style: symbolic` then makes GTK prefer the
        // *-symbolic version automatically and recolor it via the `color` property.
        // Fall back to gicon (the icon core/tray.ts composed — a themed icon, a
        // file from the item's own IconThemePath, or a pixbuf it decoded from the
        // item's ARGB32 pixmaps) for apps without a recognized name in the current
        // theme, e.g. apps that only ever send pixels.
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
        const unsubs: Array<() => void> = []
        unsubs.push(item.onIconChanged(syncIcon))

        const btn = new Gtk.Button({
            css_classes: ["bar-tray-btn"],
            child: img
        })
        // Glass tooltip (markup — SNI items expose tooltip_markup); read lazily so
        // it tracks the item's live title/tooltip without a subscription. Position
        // BOTTOM: the tray sits in the top bar, so the bubble drops below and its
        // pointer aims up at the icon (and GTK won't auto-flip it). `barTooltip` keeps
        // it off while a bar panel is open — the tray's menu IS such a panel.
        barTooltip(btn, () => item.tooltip_markup || item.title || id, { markup: true })

        // LAZY context menu — the item's dbusmenu layout is only fetched when the
        // user actually opens it, never at boot. That was originally a workaround:
        // appmenu-glib-translator parsed the remote app's layout the moment anything
        // iterated the model or called about_to_show(), and its incremental parser
        // (`layout_parse`/`get_layout_idle`, the pair in the coredump) eventually
        // read a corrupt GVariant length and aborted on a g_malloc of ~140 TB.
        // `core/dbusmenu.ts` has no incremental parser to corrupt, so the reason is
        // now plain economy: N tray items would otherwise mean N GetLayout round
        // trips at boot, waking every tray app to build a menu nobody asked for.
        //
        // The wrapper and its `items-changed` connection are built once and cached;
        // `about_to_show()` runs on EVERY open, which is what the spec asks for (an
        // app updates its rows in response) and is what keeps a stale "Mute"/"Unmute"
        // from being shown. The refresh is async, so an app that never answers
        // costs a stale menu, not a frozen bar.
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
                // The model object is stable across rebuilds (core/dbusmenu.ts mutates
                // it in place), so ONE connection covers every future layout update.
                try { menuChangedId = menuModel.connect("items-changed", repopulate) } catch (e) { }
                menuWrapper = wrapper
            }
            item.about_to_show()
            openMenu!(btn, () => menuWrapper!)
        }

        // Left click → activate the app. But items that declare `ItemIsMenu` have NO
        // activate action — the SNI spec says the menu should be shown instead — so
        // activate(0,0) would be a silent no-op. For those, left-click opens the menu.
        // ⚠️ The property DEFAULTS TO FALSE and core/tray.ts honours that; AstalTray
        // defaulted it to true, which routed every app that omits the property (most
        // of them) down this branch whether or not it had a window to raise.
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
            for (const off of unsubs) { try { off() } catch (e) { } }
            if (menuChangedId) safeDisconnect(item.menu_model, menuChangedId)
        })
        // An item of the bar's right group, like search and the widgets: the button
        // fills it, so the whole item left-clicks (activate) and right-clicks (menu);
        // barItem only paints the pill — on hover, and while this item's menu
        // (anchored on `btn`) is down.
        // The keyboard stop is the ITEM, like every other bar item (its ring follows the
        // item's hover pill); the button keeps the pointer and runs its click on the key.
        btn.focusable = false
        const capsule = barItem({ child: btn, ...barOpen(() => isBarCustomAnchor(btn)), onKey: () => btn.emit("clicked") })
        // Which installed app this is (see appForProcess above) — asked for every icon:
        // it names the ones that do not say (no title, Chromium's nameless Id), and
        // Settings lists an app's icon only while that app is still installed.
        const generic = !item.id || GENERIC_SNI_ID.test(item.id)
        const app = appForProcess(processName(ownerPid(busName)))
        const sniId = (generic && app?.id) || item.id || item.title || id
        // Two live icons with the same key (two instances of one app) get `#2`, `#3`…
        // so each still has a place of its own; the first keeps the plain key.
        const taken = new Set([...items.values()].map(v => v.key))
        let key = trayKey(sniId)
        for (let n = 2; taken.has(key); n++) key = trayKey(`${sniId}#${n}`)
        items.set(id, { widget: capsule, key })
        rememberTrayItem(sniId, app?.name || item.title || sniId,
            recordedTrayIcon(item, displayTheme, sniId) || app?.icon || "", app?.id ?? "")
    }

    const removeItem = (id: string) => {
        // Run teardown BEFORE dropping our references so the soon-to-be-freed
        // TrayItem carries none of our dangling closures into finalization.
        const clean = cleanups.get(id)
        if (clean) { clean(); cleanups.delete(id) }

        const entry = items.get(id)
        if (entry) {
            try {
                const parent = entry.widget.get_parent() as Gtk.Box | null
                parent?.remove(entry.widget)
            } catch (e) { }
            items.delete(id)
        }
    }

    // Sync Tray Mechanism
    getServiceSafe(() => getTray(), "Tray").then(tray => {
        if (!tray) return;

        const addItem = (id: string) => {
            if (!id || items.has(id)) return
            createItem(tray, id)
            onItemsChanged?.()
        }

        const delItem = (id: string) => {
            if (!id) return
            removeItem(id)
            onItemsChanged?.()
        }

        // Still routed through an idle: an item can register and vanish inside one
        // main-loop turn (an app that crashes on start), and building a capsule for
        // a dead item is wasted work either way.
        tray.onItemAdded(id => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { addItem(id); return GLib.SOURCE_REMOVE }))
        tray.onItemRemoved(id => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { delItem(id); return GLib.SOURCE_REMOVE }))

        // Seed whatever registered before this widget existed. The service is
        // constructed by the first getTray() above, so at this point items are
        // still arriving asynchronously — the subscriptions above catch those.
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            for (const item of tray.items) addItem(item.item_id)
            onItemsChanged?.()
            return GLib.SOURCE_REMOVE
        })
    })

    return {
        keys: () => [...items.values()].map(v => v.key),
        widget: (key) => [...items.values()].find(v => v.key === key)?.widget ?? null,
    }
}
