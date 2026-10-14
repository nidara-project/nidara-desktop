import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { WidgetCatalog, WidgetCatalogEntry } from "./WidgetCatalog"
import { callConn } from "./dbus"
import { SHELL_BUS, SHELL_PATH, CATALOG_SIGNAL, readCatalogReply } from "./WidgetCatalogWire"

export interface RemoteWidgetCatalog extends WidgetCatalog {
    /** First owner lookup and, if present, first snapshot. Never starts the shell. */
    ready: Promise<void>
    connected: boolean
    lastError: string | null
    refresh(): Promise<void>
    watch(changed: () => void): () => void
    dispose(): void
    setBar(id: string, on: boolean): Promise<void>
    setBarMode(id: string, mode: "always" | "active"): Promise<void>
    setCc(id: string, on: boolean): Promise<void>
    editBarOrder(): Promise<void>
}

/** Settings' side of the seam: async transport, sync cached list(), no widgets/. */
export async function createRemoteWidgetCatalog(): Promise<RemoteWidgetCatalog> {
    const bus = await new Promise<Gio.DBusConnection>((resolve, reject) => {
        Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
            try { resolve(Gio.bus_get_finish(result)) } catch (e) { reject(e) }
        })
    })
    let owner = ""
    let generation = 0
    let disposed = false
    let entries: WidgetCatalogEntry[] = []
    let snapshot = ""
    let queue: Promise<unknown> = Promise.resolve()
    const cancel = new Gio.Cancellable()
    const listeners = new Set<() => void>()
    let firstLookup!: () => void
    const ready = new Promise<void>(resolve => { firstLookup = resolve })
    const notify = () => {
        for (const cb of [...listeners]) {
            try { cb() } catch (e) { console.error("[WidgetCatalog] subscriber:", e) }
        }
    }
    const unavailable = (error: string | null) => {
        entries = []; snapshot = ""
        client.connected = false
        client.lastError = error
        notify()
    }
    // Capture the UNIQUE owner and generation when the user asks, before queueing.
    // A queued write from the old shell must never run on its replacement.
    const request = (args: string[]): Promise<void> => {
        const expectedOwner = owner, expectedGeneration = generation
        const work = queue.then(async () => {
            if (disposed || !expectedOwner || expectedGeneration !== generation)
                throw Error("Widget catalogue is disconnected")
            const result = await callConn(bus, expectedOwner, SHELL_PATH, SHELL_BUS, "Request",
                new GLib.Variant("(as)", [["widgetCatalog", ...args]]), new GLib.VariantType("(s)"),
                Gio.DBusCallFlags.NO_AUTO_START, 3000, cancel)
            if (disposed || expectedGeneration !== generation)
                throw Error("Shell changed during the widget catalogue request")
            const [text] = result.deep_unpack() as [string]
            if (text.startsWith("error:")) throw Error(text.slice(6).trim())
            const reply = readCatalogReply(text)
            // Decode all icons before replacing the good snapshot; malformed art must
            // not leave half of the catalogue installed.
            const next = reply.entries.map(({ icon, ...entry }) => {
                const decoded = icon === null ? null : Gio.Icon.new_for_string(icon)
                if (decoded !== null && !(decoded instanceof Gio.FileIcon))
                    throw Error("Widget catalogue icon is not a file icon")
                return { ...entry, icon: decoded } as WidgetCatalogEntry
            })
            const changed = snapshot !== text || !client.connected || client.lastError !== null
            entries = next; snapshot = text
            client.connected = true; client.lastError = null
            if (changed) notify()
        }).catch(e => {
            if (!disposed && expectedGeneration === generation) {
                client.lastError = String(e)
                notify()
            }
            throw e
        })
        // A refusal does not poison later requests; mutations are never retried.
        queue = work.catch(() => {})
        return work
    }
    const refreshQuietly = () => {
        const epoch = generation
        void client.refresh().catch(e => {
            if (!disposed && epoch === generation) console.warn("[WidgetCatalog]", String(e))
        })
    }
    const client: RemoteWidgetCatalog = {
        ready, connected: false, lastError: null,
        list: () => entries.map(w => ({ ...w })),
        refresh: () => request(["list"]),
        setBar: (id, on) => request(["bar", id, String(on)]),
        setBarMode: (id, mode) => request(["mode", id, mode]),
        setCc: (id, on) => request(["cc", id, String(on)]),
        editBarOrder: () => request(["editBarOrder"]),
        watch: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
        dispose: () => {
            if (disposed) return
            disposed = true; generation++; owner = ""
            cancel.cancel()
            Gio.bus_unwatch_name(watchId)
            bus.signal_unsubscribe(signalId)
            entries = []; client.connected = false
            listeners.clear(); firstLookup()
        },
    }
    const signalId = bus.signal_subscribe(SHELL_BUS, SHELL_BUS, CATALOG_SIGNAL, SHELL_PATH,
        null, Gio.DBusSignalFlags.NONE, (_conn, sender) => {
            if (!disposed && sender === owner) refreshQuietly()
        })
    const watchId = Gio.bus_watch_name_on_connection(bus, SHELL_BUS, Gio.BusNameWatcherFlags.NONE,
        (_conn, _name, uniqueOwner) => {
            if (disposed) return
            owner = uniqueOwner; generation++
            unavailable(null)
            const epoch = generation
            void client.refresh().catch(e => {
                if (!disposed && epoch === generation) console.warn("[WidgetCatalog]", String(e))
            }).finally(firstLookup)
        },
        () => {
            if (disposed) return
            owner = ""; generation++
            unavailable("Widget catalogue is disconnected")
            firstLookup()
        })
    return client
}
