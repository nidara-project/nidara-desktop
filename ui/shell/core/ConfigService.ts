import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
    configKeys, enumOf, getConfigEntry, getConfigValue, setConfigValue, describeConfig, type ConfigValue,
} from "./ConfigRegistry"
import agentConfig from "./AgentConfig"
import { t } from "./i18n"

/**
 * NIDARA — the settings, on the session bus: `org.nidara.Config1`
 * ===============================================================
 *
 * The registry agents already use (`describeConfig`/`getConfig`/`setConfig`, ConfigRegistry.ts),
 * served to other PROCESSES — first of all the native Settings of toolkit phase 1
 * (`toolkit/PHASE1.md`, D1), which carries no setting logic of its own. Agents and Settings
 * see the same keys.
 *
 *   Snapshot() → (t, t, s)  epoch, revision, and the schema WITH values at exactly that
 *                           revision: describeConfig() + `ui` + the whole enum + `catalogue`
 *                           + `available` (an unavailable key is listed as such, not omitted)
 *   Apply(s, v) → (t, v)    validated and applied; answers the revision that includes it and
 *                           the value IN FORCE after it (canonical: rounded, a URI made a path…)
 *   Updated(t, t, a{sv})    every change, with its epoch and revision
 *   Describe/Get/Set/Changed  the first members, kept as they are for their clients
 *
 * A client subscribes to `Updated`, then takes a `Snapshot`, and drops any `Updated` whose
 * revision is not above the snapshot's; a new epoch means the server restarted: snapshot
 * again, never replay (PHASE1.md [A3]). Members are only ever ADDED to v1.
 *
 * ── Rules this file keeps ───────────────────────────────────────────────────
 * - A well-known name of its own, `org.nidara.Config`, not the shell's: the service can move
 *   to nidara-sessiond (#574) later with no change to any client.
 * - Writes from the owner of `org.nidara.SettingsNative` are the native Settings' own path
 *   (read-only keys excepted). From ANY other sender they are an agent's `setConfig`: refused
 *   unless Settings → AI allows config writes. Cooperative consent, not a security boundary —
 *   a process of the same user can claim that name or write dconf (owner, 2026-10-18; real
 *   enforcement is #840's) — so this door is not wider than `setConfig` in app.ts. The owner
 *   is followed with a name watch, not asked on every write (every slider step paid it).
 * - Only real changes are announced: a service's `subscribe` re-reads on every one of its own
 *   signals (ThemeManager's covers a dozen keys), so values are compared to the last sent.
 *   Announcements are coalesced per idle, one revision per batch.
 * - Never exported by the Settings process, which registers the same entries: one server.
 */

const NAME = "org.nidara.Config"
const PATH = "/org/nidara/Config"
const SETTINGS_NAME = "org.nidara.SettingsNative"
const SCHEMA_VERSION = 1

const IFACE = `
<node>
  <interface name="org.nidara.Config1">
    <method name="Describe"><arg type="s" name="schema" direction="out"/></method>
    <method name="Get">
      <arg type="as" name="keys" direction="in"/>
      <arg type="a{sv}" name="values" direction="out"/>
    </method>
    <method name="Set">
      <arg type="s" name="key" direction="in"/>
      <arg type="v" name="value" direction="in"/>
    </method>
    <signal name="Changed"><arg type="a{sv}" name="values"/></signal>
    <method name="Snapshot">
      <arg type="t" name="epoch" direction="out"/>
      <arg type="t" name="revision" direction="out"/>
      <arg type="s" name="schema" direction="out"/>
    </method>
    <method name="Apply">
      <arg type="s" name="key" direction="in"/>
      <arg type="v" name="value" direction="in"/>
      <arg type="t" name="revision" direction="out"/>
      <arg type="v" name="canonical" direction="out"/>
    </method>
    <signal name="Updated">
      <arg type="t" name="epoch"/>
      <arg type="t" name="revision"/>
      <arg type="a{sv}" name="values"/>
    </signal>
  </interface>
</node>`

const ERROR = "org.nidara.Config1.Error"

const variant = (v: ConfigValue): GLib.Variant =>
    typeof v === "boolean" ? GLib.Variant.new_boolean(v)
        : typeof v === "number" ? GLib.Variant.new_double(v)
        : GLib.Variant.new_string(String(v))

/** A slider's flanking icons by NAME (the file's own name): the client resolves them through
 *  the interface icon theme the user chose, as the shell does (core/Icons.ts) — a path would
 *  pin one theme's drawing (PHASE1.md [A6]). */
const iconName = (icon: Gio.FileIcon) => icon.get_file().get_basename()?.replace(/\.svg$/, "")

/** What Settings needs to draw a key without any setting logic of its own. */
function uiOf(key: string): object | undefined {
    const e = getConfigEntry(key)
    const ui = e?.ui
    if (!e || !ui) return undefined
    const label = (k: string) => {
        const s = t(k as any)
        return s === k ? undefined : s
    }
    const s = ui.slider
    const values = enumOf(e)
    return {
        i18n: ui.i18n,
        title: label(ui.i18n),
        subtitle: label(`${ui.i18n}.desc`),
        control: ui.control ?? (e.type === "boolean" ? "toggle" : e.type === "enum" ? "dropdown" : e.type === "number" ? "slider" : undefined),
        ...(values && ui.optI18n ? { options: values.map(value => ({ value, label: ui.optI18n!(value) })) } : {}),
        ...(s ? {
            slider: {
                unit: s.unit, pct: s.pct, decimals: s.decimals, step: s.step,
                commitOnRelease: s.commitOnRelease, debounce: s.debounce,
                icons: s.icons?.map(iconName),
            },
        } : {}),
        ...(ui.presets ? { presets: ui.presets, presetUnit: ui.presetUnit } : {}),
    }
}

/** The schema with values, for Settings: every key of the registry, available or not. */
export function describeForSettings(): Record<string, object> {
    const schema = describeConfig() as Record<string, Record<string, unknown>>
    for (const key of configKeys(true)) {
        const e = getConfigEntry(key)!
        const entry = schema[key] ?? (schema[key] = { type: e.type, desc: e.desc })
        entry.available = e.available?.() !== false
        const values = enumOf(e)
        if (values) {
            entry.values = [...values]
            delete entry.valuesTotal
        }
        if (e.catalogue) entry.catalogue = [...e.catalogue()]
        const ui = uiOf(key)
        if (ui) entry.ui = ui
    }
    return schema
}

/** The Hyalo preview's native dock (/usr/bin/nidara-shell, started by start-shell with
 *  org.nidara.dock native-preview) writes its own `dock.*` keys from its menus, as the TS
 *  dock does in-process. Told by the sender's executable — the same cooperative check as
 *  the Settings name above, not a security boundary (#840). Goes when Config1 moves to
 *  nidara-sessiond, which authenticates it as the shell (#959). */
const NATIVE_DOCK = "/usr/bin/nidara-shell"
function isNativeDock(sender: string): Promise<boolean> {
    return new Promise(resolve => {
        Gio.DBus.session.call(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", new GLib.Variant("(s)", [sender]),
            new GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [pid] = conn!.call_finish(res).deepUnpack() as [number]
                    resolve(GLib.file_read_link(`/proc/${pid}/exe`) === NATIVE_DOCK)
                } catch {
                    resolve(false)
                }
            })
    })
}

export function exportConfigService(): void {
    let exported: any = null
    // The serving process's instance: a client that sees it change knows the server restarted.
    // Microseconds of the wall clock fit a double exactly (< 2^53); two shells never start in
    // the same microsecond and the same session.
    const epoch = GLib.get_real_time()
    let revision = 0
    let settingsOwner: string | null = null
    const sent = new Map<string, ConfigValue>()
    const pending = new Map<string, ConfigValue>()
    let flushId = 0

    const flush = () => {
        if (flushId) GLib.source_remove(flushId)
        flushId = 0
        if (!pending.size) return
        revision += 1
        const values: Record<string, GLib.Variant> = {}
        for (const [k, v] of pending) values[k] = variant(v)
        pending.clear()
        exported?.emit_signal("Changed", new GLib.Variant("(a{sv})", [values]))
        exported?.emit_signal("Updated", new GLib.Variant("(tta{sv})", [epoch, revision, values]))
    }
    const changed = (key: string, value: ConfigValue) => {
        if (sent.has(key) && sent.get(key) === value) return
        sent.set(key, value)
        pending.set(key, value)
        // One announcement per idle: a ThemeManager change re-reads a dozen keys in one go.
        if (!flushId) flushId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            flushId = 0
            flush()
            return GLib.SOURCE_REMOVE
        })
    }

    /** The gate, the registry's validation and setter; resolves with the error or null. */
    const write = async (sender: string | null, key: string, value: GLib.Variant): Promise<[string, string] | null> => {
        const fromSettings = !!sender && sender === settingsOwner
        if (!fromSettings && !agentConfig.allowConfigWrite
            && !(key.startsWith("dock.") && sender && await isNativeDock(sender)))
            return [`${ERROR}.Denied`, "config writes are disabled — enable them in Settings → AI"]
        // Read-only keys (the ai.* gate itself) are refused by the registry for every caller
        // here; the Settings window that changes them is still the GTK one.
        try {
            const result = await setConfigValue(key, String(value.deepUnpack()))
            // setConfigValue answers JSON on success and a sentence otherwise.
            return result.startsWith("{") ? null : [`${ERROR}.Invalid`, result]
        } catch (err) {
            return [`${ERROR}.Failed`, String(err)]
        }
    }

    const impl = {
        Describe: () => JSON.stringify(describeForSettings()),
        // A sync method gets its in-args as separate parameters; an *Async one gets them as
        // one array (SetAsync below). `Get([keys])` read the first KEY as the list.
        Get(keys: string[]) {
            const out: Record<string, GLib.Variant> = {}
            for (const key of keys.length ? keys : configKeys()) {
                const r = getConfigValue(key)
                if (!r.ok) throw new Error(r.error)
                out[key] = variant(r.value as ConfigValue)
            }
            return out
        },
        Snapshot() {
            const schema = describeForSettings()
            return [epoch, revision, JSON.stringify({ schemaVersion: SCHEMA_VERSION, keys: schema })]
        },
        SetAsync([key, value]: [string, GLib.Variant], invocation: Gio.DBusMethodInvocation) {
            write(invocation.get_sender(), key, value).then(error => {
                if (error) invocation.return_dbus_error(...error)
                else invocation.return_value(null)
            })
        },
        ApplyAsync([key, value]: [string, GLib.Variant], invocation: Gio.DBusMethodInvocation) {
            write(invocation.get_sender(), key, value).then(error => {
                if (error) return invocation.return_dbus_error(...error)
                // The change the setter caused is pending (its service announced it
                // synchronously): send it now, so the revision answered includes it. A no-op
                // answers the current revision and announces nothing.
                flush()
                const r = getConfigValue(key)
                invocation.return_value(new GLib.Variant("(tv)", [revision, variant(r.value as ConfigValue)]))
            })
        },
    }

    try {
        exported = Gio.DBusExportedObject.wrapJSObject(IFACE, impl)
        Gio.bus_own_name(
            Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
            (conn: Gio.DBusConnection) => {
                try {
                    exported.export(conn, PATH)
                } catch (e) {
                    console.error(`[config] could not export ${PATH}:`, e)
                }
            },
            () => console.log(`[config] serving ${NAME}`),
            () => console.warn(`[config] lost ${NAME} — another shell owns it?`),
        )
        Gio.bus_watch_name(
            Gio.BusType.SESSION, SETTINGS_NAME, Gio.BusNameWatcherFlags.NONE,
            (_c: Gio.DBusConnection, _n: string, owner: string) => { settingsOwner = owner },
            () => { settingsOwner = null },
        )
        // Held for the life of the process: an unreferenced exported object is
        // collected and stops answering with no error.
        ;(exportConfigService as any)._exported = exported
    } catch (e) {
        console.error(`[config] could not export ${NAME}:`, e)
        return
    }
    for (const key of configKeys(true)) {
        const sub = getConfigEntry(key)!.subscribe
        // The contract of `subscribe` (PHASE1.md [A3]): its FIRST call is synchronous and is the
        // current value. It seeds `sent`; it is not a change.
        sub?.(v => sent.has(key) ? changed(key, v) : void sent.set(key, v))
    }
}
