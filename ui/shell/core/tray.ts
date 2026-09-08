// tray — the shell's OWN StatusNotifierItem host AND watcher.
//
// Every app that puts an icon in the bar's tray (Telegram, Steam, Discord, an
// Electron app, anything on libappindicator) speaks `org.kde.StatusNotifierItem`
// and looks for `org.kde.StatusNotifierWatcher` on the session bus. Nidara owns
// that name, so it is both: the watcher apps register WITH, and the host that
// renders them. It replaced AstalTray on 2026-08-18 — the last Astal service.
//
// Same shape as `core/mpris.ts`, `core/bluez.ts` and `core/notifd.ts`: there is no
// library beneath it, only a freedesktop/KDE spec, and the 948 lines of Vala it
// replaces were `Gio.DBusProxy` calls doing exactly this. The menus are
// `core/dbusmenu.ts`, which is what let `appmenu-glib-translator` — a hand-built
// dependency that existed for AstalTray alone — leave with it.
//
// Items are PLAIN objects, not GObjects. There is exactly one consumer
// (`surfaces/bar/Tray.tsx`) and it subscribes with `onIconChanged`/`onChanged`, so
// nothing needs a ParamSpec — which skips the accessor trap `core/mpris.ts`
// documents, AND the failure that shaped the consumer: AstalTray's items are churny
// (Antigravity re-registers its item every few minutes), and `notify::` closures
// left on a TrayItem the library was about to free fed a `g_param_spec_unref` UAF
// that segfaulted the whole UI minutes later. A plain object has no ParamSpecs to
// over-unref.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { DbusMenu } from "./dbusmenu"
import { callConn, onConnSignal } from "./dbus"

const WATCHER_NAME = "org.kde.StatusNotifierWatcher"
const WATCHER_PATH = "/StatusNotifierWatcher"
const ITEM_IFACE = "org.kde.StatusNotifierItem"
const PROPS_IFACE = "org.freedesktop.DBus.Properties"

const WATCHER_XML = `
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg type="s" name="service" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg type="s" name="service" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s" name="service"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s" name="service"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>`

export const TrayStatus = { PASSIVE: "Passive", ACTIVE: "Active", NEEDS_ATTENTION: "NeedsAttention" } as const

/** Icon-theme lookups are a RECURSIVE directory walk of a path the app chose, and
 *  the answer cannot change while the item lives. AstalTray re-walked it inside
 *  `update_gicon`, which its property setters call up to seven times per property
 *  refresh, and a refresh happened on EVERY signal — so an app with a fat
 *  `IconThemePath` paid a full recursive readdir x7 for each title change, on the
 *  main loop. Cached here, and consulted only when the icon actually changed. */
const themeIconCache = new Map<string, string | null>()

function findIconInTheme(name: string, dir: string, depth = 0): string | null {
    const key = `${dir}\x00${name}`
    const hit = themeIconCache.get(key)
    if (hit !== undefined) return hit

    let found: string | null = null
    try {
        const e = Gio.File.new_for_path(dir).enumerate_children(
            "standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
        let info: any
        while ((info = e.next_file(null)) !== null) {
            const child = info.get_name()
            const path = GLib.build_filenamev([dir, child])
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                if (depth < 6) found = findIconInTheme(name, path, depth + 1)
                if (found) break
                continue
            }
            const dot = child.lastIndexOf(".")
            if ((dot === -1 ? child : child.slice(0, dot)) === name) { found = path; break }
        }
        e.close(null)
    } catch { found = null }

    themeIconCache.set(key, found)
    return found
}

/** SNI pixmaps are ARGB32 in NETWORK byte order; GdkPixbuf wants RGBA. Pick the
 *  largest one offered, then rotate each pixel's bytes. */
function pixmapToPixbuf(pixmaps: Array<[number, number, Uint8Array]> | null): GdkPixbuf.Pixbuf | null {
    if (!pixmaps || pixmaps.length === 0) return null
    let best = pixmaps[0]
    for (const p of pixmaps) if (p[0] > best[0]) best = p
    const [w, h, argb] = best
    if (w <= 0 || h <= 0 || !argb || argb.length < w * h * 4) return null
    try {
        const rgba = new Uint8Array(w * h * 4)
        for (let i = 0; i < w * h * 4; i += 4) {
            rgba[i] = argb[i + 1]
            rgba[i + 1] = argb[i + 2]
            rgba[i + 2] = argb[i + 3]
            rgba[i + 3] = argb[i]
        }
        return GdkPixbuf.Pixbuf.new_from_bytes(
            new GLib.Bytes(rgba), GdkPixbuf.Colorspace.RGB, true, 8, w, h, w * 4)
    } catch { return null }
}

/** The property groups a given SNI signal invalidates. AstalTray answered EVERY
 *  signal with a full `GetAll` (debounced 10 ms), so a chat app rewriting its
 *  title re-read its pixmaps and re-walked its icon theme path. The set of
 *  signals we listen to is the same, so nothing is missed that AstalTray caught —
 *  only the read is narrowed to what the signal actually says changed. */
const SIGNAL_PROPS: Record<string, string[]> = {
    NewTitle: ["Title"],
    NewIcon: ["IconName", "IconPixmap", "IconThemePath"],
    NewAttentionIcon: ["AttentionIconName", "AttentionIconPixmap"],
    NewToolTip: ["ToolTip"],
    NewStatus: ["Status"],
    NewMenu: ["Menu"],
}

const ALL_PROPS = [
    "Id", "Title", "Status", "Category", "ToolTip", "IconThemePath", "ItemIsMenu", "Menu",
    "IconName", "IconPixmap", "AttentionIconName", "AttentionIconPixmap",
]

export class TrayItem {
    /** `<busname>/<objectpath>` — the identity the consumer keys its widgets by,
     *  and the shape `surfaces/bar/Tray.tsx` splits to recover the bus name. */
    readonly item_id: string

    id = ""
    title = ""
    status: string = TrayStatus.ACTIVE
    category = ""
    icon_theme_path = ""
    /** Per the SNI spec the default is FALSE. AstalTray defaulted it to true, so
     *  an app that never publishes `ItemIsMenu` had its left-click turned into a
     *  menu open. Nidara's left-click already falls back to the menu when there is
     *  nothing to raise, so the spec default costs nothing and stops guessing. */
    is_menu = false
    gicon: any = null

    private iconName = ""
    private attentionIconName = ""
    private iconPixmap: Array<[number, number, Uint8Array]> | null = null
    private attentionIconPixmap: Array<[number, number, Uint8Array]> | null = null
    private tooltipTitle = ""
    private tooltipDescription = ""

    private menuPath = ""
    private menuObj: DbusMenu | null = null

    private _disposers: Array<() => void> = []
    private destroyed = false
    private readonly changeCbs = new Set<() => void>()
    private readonly iconCbs = new Set<() => void>()

    constructor(readonly busName: string, readonly objectPath: string) {
        this.item_id = busName + objectPath
    }

    /** The icon name in force RIGHT NOW: an item in NeedsAttention advertises a
     *  different one, and that is the whole point of the state. */
    get icon_name(): string {
        return this.status === TrayStatus.NEEDS_ATTENTION && this.attentionIconName
            ? this.attentionIconName
            : this.iconName
    }

    get tooltip_markup(): string {
        if (!this.tooltipTitle && !this.tooltipDescription) return ""
        let tt = GLib.markup_escape_text(this.tooltipTitle, -1)
        if (this.tooltipDescription) tt += "\n" + this.tooltipDescription
        return tt
    }

    get menu_model(): any { return this.menuObj?.model ?? null }
    get action_group(): any { return this.menuObj?.actions ?? null }

    onChanged(cb: () => void): () => void {
        this.changeCbs.add(cb)
        return () => this.changeCbs.delete(cb)
    }

    onIconChanged(cb: () => void): () => void {
        this.iconCbs.add(cb)
        return () => this.iconCbs.delete(cb)
    }

    /** Read every property once, then subscribe. Resolves when the item is ready
     *  to be drawn (or `false` if it never answered — a bus name can vanish
     *  between registering and our first read). */
    async start(): Promise<boolean> {
        const props = await this.getProps(ALL_PROPS)
        if (this.destroyed || !props) return false
        this.apply(props)

        const bus = Gio.DBus.session
        this._disposers.push(
            onConnSignal(
                bus,
                { sender: this.busName, iface: ITEM_IFACE, path: this.objectPath },
                (_c, _s, _p, _i, signal, params) => this.onSignal(signal, params),
            ),
            // Some items (KDE-native ones) announce changes the standard way instead of
            // with the NewXxx signals. AstalTray never saw these: its proxy swallowed
            // PropertiesChanged and only re-read on `g-signal`.
            onConnSignal(
                bus,
                { sender: this.busName, iface: PROPS_IFACE, member: "PropertiesChanged", path: this.objectPath },
                (_c, _s, _p, _i, _sig, params) => {
                    try {
                        if (params.get_child_value(0).get_string()[0] !== ITEM_IFACE) return
                        const changed: Record<string, any> = params.get_child_value(1).deep_unpack()
                        const flat: Record<string, any> = {}
                        for (const [k, v] of Object.entries(changed)) flat[k] = (v as any)?.deep_unpack?.() ?? v
                        this.apply(flat)
                    } catch { /* a malformed PropertiesChanged is not worth a refetch */ }
                },
            ),
        )
        return true
    }

    private onSignal(signal: string, params: GLib.Variant) {
        if (this.destroyed) return
        // NewStatus carries its value inline — no round trip needed for the one
        // signal that fires when an app starts blinking for attention.
        if (signal === "NewStatus") {
            try {
                const s = params.get_child_value(0).get_string()[0]
                if (s) { this.apply({ Status: s }); return }
            } catch { /* fall through to a read */ }
        }
        const props = SIGNAL_PROPS[signal]
        if (!props) return
        this.getProps(props).then(p => { if (p && !this.destroyed) this.apply(p) })
    }

    private async getProps(names: string[]): Promise<Record<string, any> | null> {
        // One GetAll beats N Gets, and an item that answers GetAll but chokes on
        // an individual Get (several Electron shims do) still works.
        try {
            const reply = await callConn(
                Gio.DBus.session,
                this.busName,
                this.objectPath,
                PROPS_IFACE,
                "GetAll",
                new GLib.Variant("(s)", [ITEM_IFACE]),
                new GLib.VariantType("(a{sv})"),
                Gio.DBusCallFlags.NONE,
                3000,
            )
            const dict = reply.get_child_value(0)
            const out: Record<string, any> = {}
            const n = dict.n_children()
            for (let i = 0; i < n; i++) {
                const entry = dict.get_child_value(i)
                const key = entry.get_child_value(0).get_string()[0]
                if (!names.includes(key)) continue
                out[key] = entry.get_child_value(1).get_variant().deep_unpack()
            }
            return out
        } catch {
            return null
        }
    }

    private apply(props: Record<string, any>) {
        let iconDirty = false
        let changed = false
        const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k)

        if (has("Id")) { const v = String(props.Id ?? ""); if (v !== this.id) { this.id = v; changed = true } }
        if (has("Title")) { const v = String(props.Title ?? ""); if (v !== this.title) { this.title = v; changed = true } }
        if (has("Category")) this.category = String(props.Category ?? "")
        if (has("ItemIsMenu")) this.is_menu = props.ItemIsMenu === true
        if (has("Status")) {
            const v = String(props.Status ?? TrayStatus.ACTIVE)
            if (v !== this.status) { this.status = v; iconDirty = true; changed = true }
        }
        if (has("IconThemePath")) {
            const v = String(props.IconThemePath ?? "")
            if (v !== this.icon_theme_path) { this.icon_theme_path = v; iconDirty = true }
        }
        if (has("IconName")) {
            const v = String(props.IconName ?? "")
            if (v !== this.iconName) { this.iconName = v; iconDirty = true }
        }
        if (has("AttentionIconName")) {
            const v = String(props.AttentionIconName ?? "")
            if (v !== this.attentionIconName) { this.attentionIconName = v; iconDirty = true }
        }
        if (has("IconPixmap")) { this.iconPixmap = props.IconPixmap ?? null; iconDirty = true }
        if (has("AttentionIconPixmap")) { this.attentionIconPixmap = props.AttentionIconPixmap ?? null; iconDirty = true }
        if (has("ToolTip")) {
            // ToolTip is `(s a(iiay) s s)` — icon name, icon pixmaps, title, body.
            // Only the two strings are ever drawn.
            const tt = props.ToolTip
            const title = Array.isArray(tt) ? String(tt[2] ?? "") : ""
            const desc = Array.isArray(tt) ? String(tt[3] ?? "") : ""
            if (title !== this.tooltipTitle || desc !== this.tooltipDescription) {
                this.tooltipTitle = title
                this.tooltipDescription = desc
                changed = true
            }
        }
        if (has("Menu")) this.setMenuPath(String(props.Menu ?? ""))

        if (iconDirty) { this.updateGicon(); changed = true }
        if (changed) for (const cb of [...this.changeCbs]) { try { cb() } catch { } }
        if (iconDirty) for (const cb of [...this.iconCbs]) { try { cb() } catch { } }
    }

    private setMenuPath(path: string) {
        if (path === this.menuPath) return
        this.menuPath = path
        this.menuObj?.destroy()
        this.menuObj = null
        if (!path || path === "/") return
        this.menuObj = new DbusMenu(this.busName, path)
    }

    private updateGicon() {
        const name = this.icon_name
        if (name) {
            if (name.startsWith("/") && GLib.file_test(name, GLib.FileTest.EXISTS)) {
                this.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(name) })
                return
            }
            if (this.icon_theme_path) {
                const path = findIconInTheme(name, this.icon_theme_path)
                if (path) { this.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) }); return }
            }
            this.gicon = new Gio.ThemedIcon({ name })
            return
        }
        const pixmaps = this.status === TrayStatus.NEEDS_ATTENTION && this.attentionIconPixmap
            ? this.attentionIconPixmap
            : this.iconPixmap
        this.gicon = pixmapToPixbuf(pixmaps)
    }

    /** Ask the app to refresh its menu before we show it, then fetch the layout.
     *  Both are async: a wedged tray app must not freeze the bar. */
    async about_to_show(): Promise<void> {
        if (!this.menuObj) return
        await this.menuObj.aboutToShow()
        await this.menuObj.refresh()
    }

    /** Subscribe to menu rebuilds (LayoutUpdated / ItemsPropertiesUpdated). */
    onMenuChanged(cb: () => void): () => void {
        if (this.menuObj) return this.menuObj.onChanged(cb)
        return () => { }
    }

    private callItem(method: string, params: GLib.Variant) {
        // UnknownMethod is normal here: SNI declares Activate/Scroll
        // optional and plenty of items implement only the menu.
        callConn(
            Gio.DBus.session,
            this.busName,
            this.objectPath,
            ITEM_IFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            3000,
        ).catch(() => { })
    }

    activate(x = 0, y = 0) { this.callItem("Activate", new GLib.Variant("(ii)", [x, y])) }
    secondary_activate(x = 0, y = 0) { this.callItem("SecondaryActivate", new GLib.Variant("(ii)", [x, y])) }
    scroll(delta: number, orientation: "horizontal" | "vertical") {
        this.callItem("Scroll", new GLib.Variant("(is)", [delta, orientation]))
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        for (const dispose of this._disposers) {
            try { dispose() } catch { }
        }
        this._disposers = []
        this.menuObj?.destroy()
        this.menuObj = null
        this.changeCbs.clear()
        this.iconCbs.clear()
    }
}

class Tray {
    private readonly itemsById = new Map<string, TrayItem>()
    /** Registrations that have not answered their first read yet. Keeps a fast
     *  register/unregister pair from leaving a half-built item behind. */
    private readonly pending = new Set<string>()
    private readonly addedCbs = new Set<(id: string) => void>()
    private readonly removedCbs = new Set<(id: string) => void>()

    private exported: any = null
    private watcherNameId = 0
    private hostNameId = 0
    private isWatcher = false
    private _disposers: Array<() => void> = []

    get items(): TrayItem[] { return [...this.itemsById.values()] }
    getItem(id: string): TrayItem | null { return this.itemsById.get(id) ?? null }

    onItemAdded(cb: (id: string) => void): () => void {
        this.addedCbs.add(cb)
        return () => this.addedCbs.delete(cb)
    }

    onItemRemoved(cb: (id: string) => void): () => void {
        this.removedCbs.add(cb)
        return () => this.removedCbs.delete(cb)
    }

    constructor() {
        this.publishWatcher()
        this.watchNameOwners()
        this.registerAsHost()
    }

    // -- watcher side ---------------------------------------------------------

    private publishWatcher() {
        const impl: any = {
            // Async form so we can read `invocation.get_sender()`: an app is allowed
            // to register by OBJECT PATH alone, in which case the bus name is
            // whoever is calling. GJS routes a method to `<Name>Async` when it
            // exists, and only then hands over the invocation.
            RegisterStatusNotifierItemAsync: (params: [string], invocation: any) => {
                const service = params[0] ?? ""
                const sender = invocation.get_sender()
                const busName = service.startsWith("/") ? sender : service
                const path = service.startsWith("/") ? service : "/StatusNotifierItem"
                try { invocation.return_value(null) } catch { }
                this.addItem(busName, path)
            },
            // Deliberately a no-op, and `IsStatusNotifierHostRegistered` is
            // hardcoded true. Some tray apps only register while a host is present
            // and never re-register when one appears, so a truthful answer costs
            // the user icons. AstalTray made the same call and documented it.
            RegisterStatusNotifierHost: (_service: string) => { },
            RegisteredStatusNotifierItems: [] as string[],
            IsStatusNotifierHostRegistered: true,
            ProtocolVersion: 0,
        }
        Object.defineProperty(impl, "RegisteredStatusNotifierItems", {
            get: () => [...this.itemsById.keys(), ...this.pending],
            enumerable: true,
        })

        try {
            this.exported = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, impl)
        } catch (e) {
            console.error("[tray] could not wrap the watcher interface:", e)
            return
        }

        this.watcherNameId = Gio.bus_own_name(
            Gio.BusType.SESSION, WATCHER_NAME, Gio.BusNameOwnerFlags.NONE,
            (conn: any) => {
                try { this.exported.export(conn, WATCHER_PATH) }
                catch (e) { console.error(`[tray] could not export ${WATCHER_PATH}:`, e) }
            },
            () => {
                this.isWatcher = true
                console.log(`[tray] serving ${WATCHER_NAME}`)
                try { this.exported.emit_signal("StatusNotifierHostRegistered", null) } catch { }
            },
            () => {
                // Another watcher (a stray astal-tray, a KDE plasmashell) owns the
                // name. We stay a HOST: subscribe to its registrations and seed from
                // its list, so the bar still shows icons instead of going empty.
                this.isWatcher = false
                console.warn(`[tray] ${WATCHER_NAME} is owned by another process — following it as a host`)
                this.followForeignWatcher()
            },
        )
        this._disposers.push(() => {
            if (this.watcherNameId) {
                try { Gio.bus_unown_name(this.watcherNameId) } catch { }
                this.watcherNameId = 0
            }
            if (this.exported) {
                try { this.exported.unexport() } catch { }
                this.exported = null
            }
        })
    }

    private followForeignWatcher() {
        const bus = Gio.DBus.session
        try {
            this._disposers.push(
                onConnSignal(
                    bus,
                    {
                        sender: WATCHER_NAME,
                        iface: WATCHER_NAME,
                        member: "StatusNotifierItemRegistered",
                        path: WATCHER_PATH,
                    },
                    (_c, _s, _p, _i, _sig, params) => {
                        try { this.addFromService(params.get_child_value(0).get_string()[0]) } catch { }
                    },
                ),
                onConnSignal(
                    bus,
                    {
                        sender: WATCHER_NAME,
                        iface: WATCHER_NAME,
                        member: "StatusNotifierItemUnregistered",
                        path: WATCHER_PATH,
                    },
                    (_c, _s, _p, _i, _sig, params) => {
                        try { this.removeItem(params.get_child_value(0).get_string()[0]) } catch { }
                    },
                ),
            )
            callConn(
                bus,
                WATCHER_NAME,
                WATCHER_PATH,
                PROPS_IFACE,
                "Get",
                new GLib.Variant("(ss)", [WATCHER_NAME, "RegisteredStatusNotifierItems"]),
                new GLib.VariantType("(v)"),
                Gio.DBusCallFlags.NONE,
                3000,
            ).then(reply => {
                const list = reply.get_child_value(0).get_variant().deep_unpack() as string[]
                for (const s of list) this.addFromService(s)
            }).catch(() => { })
        } catch (e) {
            console.error("[tray] could not follow the foreign watcher:", e)
        }
    }

    /** Register ourselves as a host. libappindicator checks for a well-known
     *  `org.kde.StatusNotifierHost-<pid>` owner before it will publish an item —
     *  AstalTray never claimed one (it forced `IsStatusNotifierHostRegistered`
     *  instead, which only works while IT is the watcher). */
    private registerAsHost() {
        const hostName = `org.kde.StatusNotifierHost-${new Gio.Credentials().get_unix_pid()}`
        this.hostNameId = Gio.bus_own_name(
            Gio.BusType.SESSION, hostName, Gio.BusNameOwnerFlags.NONE,
            null,
            () => {
                callConn(
                    Gio.DBus.session,
                    WATCHER_NAME,
                    WATCHER_PATH,
                    WATCHER_NAME,
                    "RegisterStatusNotifierHost",
                    new GLib.Variant("(s)", [hostName]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    3000,
                ).catch(() => { })
            },
            null,
        )
        this._disposers.push(() => {
            if (this.hostNameId) {
                try { Gio.bus_unown_name(this.hostNameId) } catch { }
                this.hostNameId = 0
            }
        })
    }

    // -- item bookkeeping -----------------------------------------------------

    private addFromService(service: string) {
        if (!service) return
        const slash = service.indexOf("/")
        if (slash < 0) { this.addItem(service, "/StatusNotifierItem"); return }
        this.addItem(service.slice(0, slash), service.slice(slash))
    }

    private addItem(busName: string, objectPath: string) {
        const id = busName + objectPath
        if (this.itemsById.has(id) || this.pending.has(id)) return
        this.pending.add(id)

        const item = new TrayItem(busName, objectPath)
        item.start().then(ok => {
            // Registered and unregistered before the first read landed.
            if (!this.pending.delete(id)) { item.destroy(); return }
            if (!ok) { item.destroy(); return }
            this.itemsById.set(id, item)
            this.emitWatcherSignal("StatusNotifierItemRegistered", id)
            for (const cb of [...this.addedCbs]) { try { cb(id) } catch { } }
        })
    }

    private removeItem(id: string) {
        if (this.pending.delete(id)) return
        const item = this.itemsById.get(id)
        if (!item) return
        this.itemsById.delete(id)
        item.destroy()
        this.emitWatcherSignal("StatusNotifierItemUnregistered", id)
        for (const cb of [...this.removedCbs]) { try { cb(id) } catch { } }
    }

    private emitWatcherSignal(name: string, id: string) {
        if (!this.isWatcher) return
        try { this.exported?.emit_signal(name, new GLib.Variant("(s)", [id])) } catch { }
    }

    /** An app that dies takes its items with it. AstalTray kept ONE entry per bus
     *  name, so an app publishing two icons from one connection (a mail client with
     *  one item per account) lost only the last one on exit and left the other
     *  stuck in the bar until the shell restarted. Items are keyed by bus name AND
     *  path here, and every match goes. */
    private watchNameOwners() {
        try {
            this._disposers.push(
                onConnSignal(
                    Gio.DBus.session,
                    {
                        sender: "org.freedesktop.DBus",
                        iface: "org.freedesktop.DBus",
                        member: "NameOwnerChanged",
                        path: "/org/freedesktop/DBus",
                    },
                    (_c, _s, _p, _i, _sig, params) => {
                        try {
                            const [name, , newOwner] = params.deep_unpack() as [string, string, string]
                            if (newOwner !== "") return
                            for (const [id, item] of [...this.itemsById]) {
                                if (item.busName === name) this.removeItem(id)
                            }
                            for (const id of [...this.pending]) {
                                if (id.startsWith(name + "/")) this.pending.delete(id)
                            }
                        } catch { }
                    },
                ),
            )
        } catch (e) {
            console.error("[tray] could not watch NameOwnerChanged:", e)
        }
    }

    destroy(): void {
        for (const item of this.itemsById.values()) {
            item.destroy()
        }
        this.itemsById.clear()
        this.pending.clear()
        for (const dispose of this._disposers) {
            try { dispose() } catch { }
        }
        this._disposers = []
        this.addedCbs.clear()
        this.removedCbs.clear()
        if (instance === this) instance = null
    }
}

let instance: Tray | null = null

export function getDefault(): Tray {
    if (!instance) instance = new Tray()
    return instance
}

export type { Tray }
export default getDefault
