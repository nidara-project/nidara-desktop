#!/usr/bin/env gjs
// fake-sni.js — a fake StatusNotifierItem tray app, with a dbusmenu, for testing
// `core/tray.ts` + `core/dbusmenu.ts` without installing Telegram. It is what
// `tray-probe.ts` drives, and it is also usable by hand: run it inside a Nidara
// session and an icon appears in the bar.
//
//   gjs scripts/dev/fake-sni.js [options]
//
//   --id NAME          the SNI `Id` property           (default "fakesni")
//   --icon NAME        `IconName`                       (default "dialog-information")
//   --pixmap           publish NO IconName, only a 2x2 `IconPixmap`. That is the
//                      path where the host has to decode ARGB32-network-order
//                      pixels itself, and the ONLY way to prove it got the byte
//                      order right.
//   --menu-path PATH   dbusmenu object path            (default "/MenuBar")
//   --no-menu          publish `Menu` as "/" (an item with no context menu)
//   --item-is-menu     publish `ItemIsMenu = true`
//   --two              register a SECOND item from this SAME bus connection
//                      (/StatusNotifierItem2). One app, two icons — the case a
//                      host that keys its registry by bus name alone gets wrong.
//   --deep             give the menu an extra nesting level, so a host that asks
//                      for recursionDepth=1 cannot see the whole tree.
//
// It also exports `org.nidara.FakeSNI` at /FakeControl:
//   GetLog() -> as       every inbound call, in order ("Activate 3,4",
//                        "Event 8 clicked", "AboutToShow 0", …). This is how a
//                        probe proves a click REACHED the app instead of just
//                        not throwing.
//   SetStatus(s)         change Status + emit NewStatus
//   SetTitle(s)          change Title + emit NewTitle
//   SetLabel(i, s)       relabel a menu row + emit ItemsPropertiesUpdated
//   Quit()               exit (tests that the host drops the item on name loss)

const { GLib, Gio } = imports.gi

// ── options ──────────────────────────────────────────────────────────────────
const opts = { id: "fakesni", icon: "dialog-information", menuPath: "/MenuBar" }
let pixmapOnly = false, noMenu = false, itemIsMenu = false, two = false, deep = false
for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i]
    if (a === "--id") opts.id = ARGV[++i]
    else if (a === "--icon") opts.icon = ARGV[++i]
    else if (a === "--menu-path") opts.menuPath = ARGV[++i]
    else if (a === "--pixmap") pixmapOnly = true
    else if (a === "--no-menu") noMenu = true
    else if (a === "--item-is-menu") itemIsMenu = true
    else if (a === "--two") two = true
    else if (a === "--deep") deep = true
}

const log = []
const record = s => { log.push(s); print(`[fake-sni] ${s}`) }

let title = "Fake Tray App"
let status = "Active"

// ── the item ─────────────────────────────────────────────────────────────────
// `ItemIsMenu` is only DECLARED when asked for. An app that never publishes it is
// the common case (most GTK/Qt trays do not), and it is the case where the spec
// default (false) and AstalTray's default (true) disagree about what a left click
// means — so the probe needs an item that genuinely lacks the property.
const ITEM_XML_TEMPLATE = `<node>
 <interface name="org.kde.StatusNotifierItem">
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="Category" type="s" access="read"/>
@ITEM_IS_MENU@  <property name="Menu" type="o" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <signal name="NewTitle"/>
  <signal name="NewIcon"/>
  <signal name="NewAttentionIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg type="s"/></signal>
 </interface></node>`

const ITEM_XML = ITEM_XML_TEMPLATE.replace("@ITEM_IS_MENU@",
    itemIsMenu ? '  <property name="ItemIsMenu" type="b" access="read"/>\n' : "")

// A 2x2 image in ARGB32, network (big-endian) order — the wire format SNI
// mandates. Pixel 0 is opaque red: A=0xff R=0xff G=0x00 B=0x00. A host that
// forgets to rotate the bytes renders it as opaque BLUE (or transparent red),
// so the probe reads pixel 0 back and the mistake cannot hide.
const PIXMAP_ARGB = [
    0xff, 0xff, 0x00, 0x00,   // red
    0xff, 0x00, 0xff, 0x00,   // green
    0xff, 0x00, 0x00, 0xff,   // blue
    0x80, 0xff, 0xff, 0xff,   // half-transparent white
]

function itemProperty(name) {
    switch (name) {
        case "Id": return new GLib.Variant("s", opts.id)
        case "Title": return new GLib.Variant("s", title)
        case "Status": return new GLib.Variant("s", status)
        case "Category": return new GLib.Variant("s", "ApplicationStatus")
        case "ItemIsMenu": return new GLib.Variant("b", itemIsMenu)
        case "Menu": return new GLib.Variant("o", noMenu ? "/" : opts.menuPath)
        case "IconName": return new GLib.Variant("s", pixmapOnly ? "" : opts.icon)
        case "AttentionIconName": return new GLib.Variant("s", pixmapOnly ? "" : "dialog-warning")
        case "IconPixmap":
            return pixmapOnly
                ? new GLib.Variant("a(iiay)", [[2, 2, PIXMAP_ARGB]])
                : new GLib.Variant("a(iiay)", [])
        case "ToolTip":
            return new GLib.Variant("(sa(iiay)ss)", ["", [], "Fake tooltip <b>title</b>", "and its body"])
    }
    return null
}

// ── the dbusmenu ─────────────────────────────────────────────────────────────
const MENU_XML = `<node>
 <interface name="com.canonical.dbusmenu">
  <method name="GetLayout">
   <arg type="i" name="parentId" direction="in"/>
   <arg type="i" name="recursionDepth" direction="in"/>
   <arg type="as" name="propertyNames" direction="in"/>
   <arg type="u" name="revision" direction="out"/>
   <arg type="(ia{sv}av)" name="layout" direction="out"/>
  </method>
  <method name="Event">
   <arg type="i" name="id" direction="in"/>
   <arg type="s" name="eventId" direction="in"/>
   <arg type="v" name="data" direction="in"/>
   <arg type="u" name="timestamp" direction="in"/>
  </method>
  <method name="AboutToShow">
   <arg type="i" name="id" direction="in"/>
   <arg type="b" name="needUpdate" direction="out"/>
  </method>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
 </interface></node>`

// id → { props, children }. Ids are stable so a probe can assert on them.
const labels = {
    1: "Open Fake App",
    4: "Mute notifications",
    5: "Disabled row",
    6: "More",
    7: "Nested row",
    9: "Quit Fake App",
    11: "Deeper row",
}

function menuTree() {
    const nested = [{ id: 7, props: { label: labels[7] } }]
    if (deep) nested.push({ id: 10, props: { label: "Even more", "children-display": "submenu" },
                            children: [{ id: 11, props: { label: labels[11] } }] })
    return {
        id: 0,
        props: { "children-display": "submenu" },
        children: [
            { id: 1, props: { label: labels[1] } },
            { id: 2, props: { label: "Invisible row", visible: false } },
            { id: 3, props: { type: "separator" } },
            { id: 4, props: { label: labels[4], "toggle-type": "checkmark", "toggle-state": 1 } },
            { id: 5, props: { label: labels[5], enabled: false } },
            { id: 6, props: { label: labels[6], "children-display": "submenu" }, children: nested },
            { id: 9, props: { label: labels[9] } },
        ],
    }
}

function propsVariant(props, wanted) {
    const builder = new GLib.VariantBuilder(new GLib.VariantType("a{sv}"))
    for (const [k, v] of Object.entries(props)) {
        if (wanted && wanted.length && !wanted.includes(k)) continue
        let val
        if (typeof v === "boolean") val = new GLib.Variant("b", v)
        else if (typeof v === "number") val = new GLib.Variant("i", v)
        else val = new GLib.Variant("s", String(v))
        builder.add_value(new GLib.Variant("{sv}", [k, val]))
    }
    return builder.end()
}

/** Serialise a node as `(ia{sv}av)`, honouring recursionDepth exactly the way a
 *  real app does: -1 unlimited, 0 = this node only, N = N levels of children. */
function nodeVariant(node, depth, wanted) {
    const kids = new GLib.VariantBuilder(new GLib.VariantType("av"))
    if (depth !== 0) {
        for (const child of node.children ?? []) {
            kids.add_value(new GLib.Variant("v", nodeVariant(child, depth < 0 ? -1 : depth - 1, wanted)))
        }
    }
    // ⚠️ GJS will NOT accept an already-built GVariant as a member of a format
    // string ("(ia{sv}av)" with a GVariant in the array silently produces garbage
    // and the marshaller throws INSIDE the method handler). Tuples that contain
    // built variants have to go through new_tuple.
    return GLib.Variant.new_tuple([
        GLib.Variant.new_int32(node.id),
        propsVariant(node.props, wanted),
        kids.end(),
    ])
}

function findNode(node, id) {
    if (node.id === id) return node
    for (const c of node.children ?? []) {
        const hit = findNode(c, id)
        if (hit) return hit
    }
    return null
}

let revision = 1

// ── control interface ────────────────────────────────────────────────────────
const CONTROL_XML = `<node>
 <interface name="org.nidara.FakeSNI">
  <method name="GetLog"><arg type="as" direction="out"/></method>
  <method name="SetStatus"><arg type="s" direction="in"/></method>
  <method name="SetTitle"><arg type="s" direction="in"/></method>
  <method name="SetLabel"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Quit"/>
 </interface></node>`

// ── wiring ───────────────────────────────────────────────────────────────────
const bus = Gio.DBus.session

// ⚠️ A method-call handler that throws never replies, and the caller just sees a
// timeout — which reads exactly like "the host never called us". That cost a
// debugging round on the very first run of tray-probe. Every handler goes through
// here so a broken FAKE announces itself as a D-Bus error instead of hiding as a
// silence in the code under test.
function guard(handler) {
    return (...args) => {
        const invocation = args[6]
        try {
            handler(...args)
        } catch (e) {
            printerr(`[fake-sni] handler ${args[4]} threw: ${e}\n${e?.stack ?? ""}`)
            try { invocation.return_dbus_error("org.nidara.FakeSNI.Error", String(e)) } catch { }
        }
    }
}

const itemInfo = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
const menuInfo = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
const controlInfo = Gio.DBusNodeInfo.new_for_xml(CONTROL_XML).interfaces[0]

const itemPaths = two ? ["/StatusNotifierItem", "/StatusNotifierItem2"] : ["/StatusNotifierItem"]

for (const path of itemPaths) {
    bus.register_object(
        path, itemInfo,
        guard((_c, _sender, _path, _iface, method, params, invocation) => {
            if (method === "Activate" || method === "SecondaryActivate") {
                const [x, y] = params.deep_unpack()
                record(`${method} ${x},${y} ${path}`)
                invocation.return_value(null)
            } else if (method === "Scroll") {
                const [d, o] = params.deep_unpack()
                record(`Scroll ${d} ${o}`)
                invocation.return_value(null)
            } else {
                invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            }
        }),
        (_c, _sender, _path, _iface, name) => itemProperty(name),
        null,
    )
}

if (!noMenu) {
    bus.register_object(
        opts.menuPath, menuInfo,
        guard((_c, _sender, _path, _iface, method, params, invocation) => {
            if (method === "GetLayout") {
                const [parentId, depth, wanted] = params.deep_unpack()
                record(`GetLayout ${parentId} depth=${depth}`)
                const node = findNode(menuTree(), parentId)
                if (!node) {
                    invocation.return_dbus_error("com.canonical.dbusmenu.Error", "no such id")
                    return
                }
                invocation.return_value(GLib.Variant.new_tuple([
                    GLib.Variant.new_uint32(revision),
                    nodeVariant(node, depth, wanted),
                ]))
            } else if (method === "Event") {
                const [id, eventId] = params.deep_unpack()
                record(`Event ${id} ${eventId}`)
                invocation.return_value(null)
            } else if (method === "AboutToShow") {
                const [id] = params.deep_unpack()
                record(`AboutToShow ${id}`)
                invocation.return_value(new GLib.Variant("(b)", [false]))
            } else {
                invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            }
        }),
        null, null,
    )
}

bus.register_object(
    "/FakeControl", controlInfo,
    guard((_c, _sender, _path, _iface, method, params, invocation) => {
        switch (method) {
            case "GetLog":
                invocation.return_value(new GLib.Variant("(as)", [log]))
                break
            case "SetStatus": {
                status = params.deep_unpack()[0]
                for (const path of itemPaths) {
                    bus.emit_signal(null, path, "org.kde.StatusNotifierItem", "NewStatus",
                        new GLib.Variant("(s)", [status]))
                }
                invocation.return_value(null)
                break
            }
            case "SetTitle": {
                title = params.deep_unpack()[0]
                for (const path of itemPaths) {
                    bus.emit_signal(null, path, "org.kde.StatusNotifierItem", "NewTitle", null)
                }
                invocation.return_value(null)
                break
            }
            case "SetLabel": {
                const [id, text] = params.deep_unpack()
                labels[id] = text
                revision++
                // Announce it the cheap way (properties), NOT LayoutUpdated: a host
                // that only listens for LayoutUpdated shows a stale row forever.
                const changed = new GLib.VariantBuilder(new GLib.VariantType("a(ia{sv})"))
                changed.add_value(GLib.Variant.new_tuple([
                    GLib.Variant.new_int32(id),
                    propsVariant({ label: text }, null),
                ]))
                bus.emit_signal(null, opts.menuPath, "com.canonical.dbusmenu", "ItemsPropertiesUpdated",
                    GLib.Variant.new_tuple([
                        changed.end(),
                        new GLib.VariantBuilder(new GLib.VariantType("a(ias)")).end(),
                    ]))
                invocation.return_value(null)
                break
            }
            case "Quit":
                invocation.return_value(null)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { loop.quit(); return GLib.SOURCE_REMOVE })
                break
            default:
                invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
        }
    }),
    null, null,
)

const loop = new GLib.MainLoop(null, false)

// Own a well-known name so a probe can address us without knowing our unique
// name, then register with the watcher exactly as a real tray app does.
const busName = `org.kde.StatusNotifierItem-${new Gio.Credentials().get_unix_pid()}-1`
Gio.bus_own_name(
    Gio.BusType.SESSION, busName, Gio.BusNameOwnerFlags.NONE,
    null,
    () => {
        for (const path of itemPaths) {
            // With --two BOTH register by OBJECT PATH, which is the form that makes
            // the watcher take the bus name from the CALLER — so both entries share
            // one bus name. A watcher that keys its registry by bus name alone then
            // has the second overwrite the first, and only one of the two icons is
            // ever cleaned up when the app exits.
            const service = two ? path : busName
            bus.call(
                "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
                new GLib.Variant("(s)", [service]), null,
                Gio.DBusCallFlags.NONE, 3000, null,
                (_s, res) => {
                    try { bus.call_finish(res); print(`[fake-sni] registered ${service}`) }
                    catch (e) { printerr(`[fake-sni] register failed: ${e.message}`) }
                },
            )
        }
    },
    () => printerr(`[fake-sni] could not own ${busName}`),
)

print(`[fake-sni] ${busName} up (${itemPaths.join(", ")})`)
loop.run()
