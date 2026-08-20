// dbusmenu — `com.canonical.dbusmenu` → a live `Gio.Menu` + `Gio.SimpleActionGroup`.
//
// This is the client half of the tray's context menus. It replaced
// `appmenu-glib-translator` (the `DBusMenu.Importer` AstalTray leaned on) on
// 2026-08-18, together with AstalTray itself — that translator existed in the
// dependency list for one reason only, and it is the reason `core/tray.ts` exists.
//
// **Why this is ~200 lines when the C it replaces is ~2100.** The translator is a
// general-purpose one: it maintains a GMenuModel that stays in sync item-by-item,
// so it fetches `GetLayout` with recursionDepth=1 per level, keeps one model object
// per submenu, diffs sections on every update, and emits `items-changed` at the
// right index. Nidara needs none of that, because its ONE consumer
// (`common/NidaraMenu.ts`) flattens the whole model into a `Gtk.Box` of rows every
// time it renders. So we ask for the entire tree in a single `GetLayout(0, -1, …)`
// and rebuild the `Gio.Menu` in place. `Gio.Menu.remove_all()` + re-append emits
// `items-changed` for free, which is exactly the signal the consumer already
// listens to.
//
// That deletes the code that was crashing: the translator's `layout_parse` /
// `get_layout_idle` pair is what appeared in the coredump behind the ~140 TB
// `g_malloc` (a corrupt GVariant length read while re-parsing a LayoutUpdated),
// and it is why `surfaces/bar/Tray.tsx` builds its menus lazily. There is no
// incremental parser here to corrupt.
//
// Toggle and icon attributes (`toggle-type`, `toggle-state`, `icon-name`) are
// attached to `Gio.MenuItem` instances so `common/NidaraMenu.ts` renders
// checkmarks and icons while keeping actions stateful.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

const IFACE = "com.canonical.dbusmenu"

/** Properties we ask for. Same set the translator requested, minus the four it
 *  fetched and never rendered (`accessible-desc`, `disposition`, `shortcut`,
 *  `icon-data`) — an app that ships a 64×64 `icon-data` per row paid for it on
 *  every layout fetch, and no Nidara menu row has ever drawn one. */
const PROPS = ["type", "label", "enabled", "visible", "icon-name", "toggle-type", "toggle-state", "children-display"]

/** Short: a hung tray app must not stall a menu open. The translator called
 *  `dbus_menu_xml_call_event_sync` straight from the action handler, on the main
 *  loop, at the default 25 s timeout — one wedged app froze the whole shell. */
const CALL_TIMEOUT_MS = 2000

type Props = Record<string, any>

interface Node {
    id: number
    props: Props
    children: Node[]
}

function unpackProps(v: GLib.Variant): Props {
    const out: Props = {}
    try {
        const n = v.n_children()
        for (let i = 0; i < n; i++) {
            const entry = v.get_child_value(i)
            const key = entry.get_child_value(0).get_string()[0]
            out[key] = entry.get_child_value(1).get_variant().deep_unpack()
        }
    } catch { /* a malformed a{sv} costs us that node's props, not the menu */ }
    return out
}

/** `(ia{sv}av)` → Node, recursively. The `av` children each hold one such tuple. */
function unpackNode(v: GLib.Variant): Node {
    const id = v.get_child_value(0).get_int32()
    const props = unpackProps(v.get_child_value(1))
    const children: Node[] = []
    const kids = v.get_child_value(2)
    const n = kids.n_children()
    for (let i = 0; i < n; i++) {
        try { children.push(unpackNode(kids.get_child_value(i).get_variant())) } catch { }
    }
    return { id, props, children }
}

const isTrue = (v: any, dflt: boolean) => (typeof v === "boolean" ? v : dflt)

export class DbusMenu {
    /** Stable objects: the consumer connects to these ONCE and we mutate them in
     *  place, so a layout update never invalidates a widget's references. */
    readonly model = new Gio.Menu()
    readonly actions = new Gio.SimpleActionGroup()

    private subs: number[] = []
    private destroyed = false
    private pending = false
    /** Actions currently installed, so a rebuild can drop the ones that vanished
     *  instead of leaking one GSimpleAction per row per update. */
    private actionNames = new Set<string>()

    private readonly changeCbs = new Set<() => void>()

    /** Subscribe to rebuilds. The `model` and `actions` objects themselves are
     *  stable, so a consumer that connected to `items-changed` does not need this;
     *  it exists for anything that has to re-read `get_n_items()` itself. */
    onChanged(cb: () => void): () => void {
        this.changeCbs.add(cb)
        return () => this.changeCbs.delete(cb)
    }

    constructor(private busName: string, private objectPath: string) {
        const bus = Gio.DBus.session
        // LayoutUpdated(u revision, i parent) — parent is which subtree changed; we
        // always refetch the whole tree, so the argument is only a trigger.
        this.subs.push(bus.signal_subscribe(
            busName, IFACE, "LayoutUpdated", objectPath, null, Gio.DBusSignalFlags.NONE,
            () => this.refresh(),
        ))
        // ItemsPropertiesUpdated(a(ia{sv}) a(ias)) — label/enabled churn (Telegram
        // rewrites its "Unmute" row). Cheaper to refetch than to patch a row we do
        // not keep an index for.
        this.subs.push(bus.signal_subscribe(
            busName, IFACE, "ItemsPropertiesUpdated", objectPath, null, Gio.DBusSignalFlags.NONE,
            () => this.refresh(),
        ))
    }

    private call(method: string, params: GLib.Variant, reply: string | null): Promise<GLib.Variant | null> {
        return new Promise(resolve => {
            try {
                Gio.DBus.session.call(
                    this.busName, this.objectPath, IFACE, method, params,
                    reply ? new GLib.VariantType(reply) : null,
                    Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null,
                    (_src, res) => {
                        try { resolve(Gio.DBus.session.call_finish(res)) } catch { resolve(null) }
                    },
                )
            } catch { resolve(null) }
        })
    }

    /** Tell the app its menu is about to open so it can refresh rows. Per spec the
     *  reply says whether the layout changed — we ignore it and let LayoutUpdated
     *  drive, because apps that answer `false` and then update are common. */
    aboutToShow(): Promise<void> {
        return this.call("AboutToShow", new GLib.Variant("(i)", [0]), "(b)").then(() => undefined)
    }

    /** Fetch the WHOLE tree in one call and rebuild. `-1` = unlimited recursion. */
    async refresh(): Promise<void> {
        if (this.destroyed || this.pending) return
        this.pending = true
        const reply = await this.call(
            "GetLayout",
            new GLib.Variant("(iias)", [0, -1, PROPS]),
            "(u(ia{sv}av))",
        )
        this.pending = false
        if (this.destroyed || !reply) return
        try {
            this.rebuild(unpackNode(reply.get_child_value(1)))
        } catch { return }
        for (const cb of [...this.changeCbs]) { try { cb() } catch { } }
    }

    private rebuild(root: Node) {
        const seen = new Set<string>()

        // A dbusmenu is a flat list broken up by "separator" rows; GMenuModel wants
        // sections. Accumulate into `section`, and start a new one at each separator
        // — that is what makes NidaraMenu draw its divider.
        const fill = (target: Gio.Menu, node: Node, depth: number) => {
            if (depth > 8) return
            let section = new Gio.Menu()
            const flush = () => {
                if (section.get_n_items() > 0) target.append_section(null, section)
                section = new Gio.Menu()
            }

            for (const child of node.children) {
                const p = child.props
                if (!isTrue(p["visible"], true)) continue
                if (p["type"] === "separator") { flush(); continue }

                const label = String(p["label"] ?? "")

                if (p["children-display"] === "submenu") {
                    const sub = new Gio.Menu()
                    fill(sub, child, depth + 1)
                    if (sub.get_n_items() === 0) continue
                    const item = Gio.MenuItem.new(label || null, null)
                    item.set_submenu(sub)
                    section.append_item(item)
                    continue
                }

                const name = `id-${child.id}`
                seen.add(name)
                this.ensureAction(name, child.id, p)
                const item = Gio.MenuItem.new(label || "…", `dbusmenu.${name}`)
                if (p["icon-name"]) {
                    item.set_attribute_value("icon-name", GLib.Variant.new_string(String(p["icon-name"])))
                }
                if (p["toggle-type"]) {
                    item.set_attribute_value("toggle-type", GLib.Variant.new_string(String(p["toggle-type"])))
                    item.set_attribute_value("toggle-state", GLib.Variant.new_boolean(p["toggle-state"] === 1))
                }
                if (p["enabled"] !== undefined) {
                    item.set_attribute_value("enabled", GLib.Variant.new_boolean(isTrue(p["enabled"], true)))
                }
                section.append_item(item)
            }
            flush()
        }

        this.model.remove_all()
        fill(this.model, root, 0)

        for (const name of [...this.actionNames]) {
            if (seen.has(name)) continue
            this.actions.remove_action(name)
            this.actionNames.delete(name)
        }
    }

    private ensureAction(name: string, id: number, p: Props) {
        const toggle = p["toggle-type"]
        const enabled = isTrue(p["enabled"], true)

        let action = this.actions.lookup_action(name) as any
        if (!action) {
            action = toggle === "checkmark" || toggle === "radio"
                ? Gio.SimpleAction.new_stateful(name, null, GLib.Variant.new_boolean(p["toggle-state"] === 1))
                : Gio.SimpleAction.new(name, null)
            action.connect("activate", () => this.event(id))
            this.actions.add_action(action)
            this.actionNames.add(name)
        }
        action.set_enabled(enabled)
    }

    /** `Event(id, "clicked", data, timestamp)`. Fire-and-forget and ASYNC — the
     *  reply carries nothing, and a click must never block the compositor's shell
     *  on a remote app's main loop. */
    private event(id: number) {
        this.call(
            "Event",
            new GLib.Variant("(isvu)", [id, "clicked", GLib.Variant.new_int32(0), 0]),
            null,
        )
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        for (const s of this.subs) {
            try { Gio.DBus.session.signal_unsubscribe(s) } catch { }
        }
        this.subs = []
        this.changeCbs.clear()
    }
}

export default DbusMenu
