import { recordUserCancel, takeUserCancel, consumeUserCancel } from "../../ui/shell/core/NetworkCancels"
// A real, private D-Bus server/client walk; no GTK, live shell or user settings.
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { callConn } from "../../ui/shell/core/dbus"
import type { WidgetCatalog, WidgetCatalogEntry } from "../../ui/shell/core/WidgetCatalog"
import { widgetCatalogRequest, SHELL_BUS, SHELL_PATH, CATALOG_SIGNAL } from "../../ui/shell/core/WidgetCatalogWire"
import { createRemoteWidgetCatalog } from "../../ui/shell/core/WidgetCatalogRemote"
import { exit } from "system"

const loop = new GLib.MainLoop(null, false)
const args = (globalThis as any).ARGV as string[]
const sleep = (ms: number) => new Promise<void>(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE }))
function check(ok: boolean, message: string): void {
    if (!ok) throw Error(message)
    print(`PASS ${message}`)
}
async function until(test: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) { if (test()) return; await sleep(50) }
    throw Error("Timed out waiting for catalogue state")
}

if (args[0] === "server") {
    recordUserCancel("fixture-uuid")
    const entry: WidgetCatalogEntry = {
        id: "optional", name: "Control", icon: Gio.FileIcon.new(Gio.File.new_for_path("/tmp/ícono con espacios.svg")),
        category: "utilities", barOrder: 10, canBar: true, canCc: true,
        available: true, bar: false, barMode: "always", cc: false, ccFixed: false, ccFits: true,
    }
    const entries = [entry,
        { ...entry, id: "fixed", ccFixed: true, cc: true },
        { ...entry, id: "full", ccFits: false },
        { ...entry, id: "missing", available: false },
        { ...entry, id: "plain", barMode: null, canCc: false },
    ]
    let writes = 0, edits = 0, delayList = false
    const source: WidgetCatalog = {
        list: () => entries,
        setBar: (id, on) => { writes++; entries.find(w => w.id === id)!.bar = on },
        setBarMode: (id, mode) => { writes++; entries.find(w => w.id === id)!.barMode = mode },
        setCc: (id, on) => { writes++; entries.find(w => w.id === id)!.cc = on },
        editBarOrder: () => { edits++ },
    }
    const xml = `<node><interface name="org.nidara.Shell"><signal name="WidgetCatalogChanged"/>
        <method name="Request"><arg type="as" direction="in"/><arg type="s" direction="out"/></method>
        </interface></node>`
    const exported = Gio.DBusExportedObject.wrapJSObject(xml, {
        RequestAsync([argv]: [string[]], invocation: any) {
            const respond = (text: string) => invocation.return_value(new GLib.Variant("(s)", [text]))
            if (argv[0] === "takeNetworkCancel") respond(String(takeUserCancel(argv[1])))
            else if (argv[0] === "probe-stop") {
                respond("ok")
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { loop.quit(); return GLib.SOURCE_REMOVE })
            } else if (argv[0] === "probe-delay") {
                delayList = true; respond("ok")
            } else if (argv[0] === "probe-count") respond(JSON.stringify({ writes, edits }))
            else if (argv[0] === "probe-external") {
                entry.bar = false
                respond("ok"); exported.emit_signal(CATALOG_SIGNAL, null)
            } else if (argv[0] === "probe-malformed") {
                // The next list must fail schema validation, not corrupt the cache.
                entry.available = "bad" as any
                respond("ok")
            } else if (argv[0] === "widgetCatalog") {
                if (delayList && argv[1] === "list") {
                    delayList = false
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        respond("error: delayed fixture"); return GLib.SOURCE_REMOVE
                    })
                    return
                }
                void widgetCatalogRequest(source, argv.slice(1)).then(text => {
                    respond(text)
                    if (argv[1] && argv[1] !== "list") exported.emit_signal(CATALOG_SIGNAL, null)
                }).catch(e => respond(`error: ${e}`))
            } else respond("error: unknown command")
        },
    })
    Gio.bus_own_name(Gio.BusType.SESSION, SHELL_BUS, Gio.BusNameOwnerFlags.NONE,
        conn => exported.export(conn, SHELL_PATH), () => print(`SERVER ${args[1]}`), () => {})
} else {
    void (async () => {
        const client = await createRemoteWidgetCatalog()
        await client.ready
        await until(() => client.connected)
        const request = async (argv: string[]) => {
            const reply = await callConn(Gio.DBus.session, SHELL_BUS, SHELL_PATH, SHELL_BUS, "Request",
                new GLib.Variant("(as)", [argv]), new GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, 3000)
            return (reply.deep_unpack() as [string])[0]
        }
        check(await consumeUserCancel("fixture-uuid"), "Settings reads cancellation recorded by the shell process")
        check(!await consumeUserCancel("fixture-uuid"), "network cancellation is consumed once")
        check(client.list().length === 5, "initial catalogue over D-Bus")
        check(client.list()[0].icon?.to_string() === "/tmp/ícono con espacios.svg", "file icon round-trip")
        let notices = 0
        const off = client.watch(() => { notices++ })
        await client.setBar("optional", true)
        check(client.list()[0].bar, "bar change read back before resolve")
        await client.setBarMode("optional", "active")
        check(client.list()[0].barMode === "active", "bar mode change read back")
        await client.setCc("optional", true)
        check(client.list()[0].cc, "Control Center placement read back")
        await client.setCc("optional", false)
        await client.editBarOrder()
        check(JSON.parse(await request(["probe-count"])).edits === 1, "edit command once")
        const count = JSON.parse(await request(["probe-count"])).writes
        for (const argv of [
            ["bar", "unknown", "true"], ["bar", "optional", "yes"], ["bar", "optional", "true", "extra"],
            ["mode", "optional", "bogus"], ["mode", "plain", "active"], ["cc", "fixed", "false"],
            ["cc", "full", "true"], ["cc", "missing", "true"], ["bar", "missing", "true"],
            ["cc", "plain", "true"], ["editBarOrder", "extra"],
        ]) check((await request(["widgetCatalog", ...argv])).startsWith("error:"), `refused ${argv.join(" ")}`)
        check(JSON.parse(await request(["probe-count"])).writes === count, "invalid requests have no writes")
        await request(["probe-external"])
        await until(() => !client.list()[0].bar)
        check(notices > 0, "external invalidation refreshes cache")
        await request(["probe-malformed"])
        let rejected = false
        try { await client.refresh() } catch { rejected = true }
        check(rejected && client.list().length === 5, "malformed reply preserves last valid snapshot")
        await request(["probe-delay"])
        const pendingRead = client.refresh()
        const pendingWrite = client.setBar("optional", true)
        // Install rejection handlers immediately, before taking the owner down.
        const pending = Promise.allSettled([pendingRead, pendingWrite])
        await request(["probe-stop"])
        await until(() => !client.connected && client.list().length === 0)
        check((await pending).every(r => r.status === "rejected"), "old-owner queued write is not sent")
        rejected = false
        try { await client.setBar("optional", true) } catch { rejected = true }
        check(rejected, "disconnected mutation refused")
        await until(() => client.connected)
        check(client.list()[0].bar === false && client.list()[0].barMode === "always", "restart gets fresh state")
        check(JSON.parse(await request(["probe-count"])).writes === 0, "no mutations replayed on restart")
        await client.setBar("optional", true)
        check(client.list()[0].bar, "mutation works after restart")
        off(); const before = notices
        await client.setBar("optional", false)
        check(notices === before, "watch disposer disconnects")
        client.dispose(); client.dispose()
        check(client.list().length === 0 && !client.connected, "client disposal is idempotent")
        await request(["probe-stop"])
        print("CATALOG_IPC_OK")
    })().then(() => loop.quit()).catch(e => { printerr(String(e)); exit(1) })
}
loop.run()
