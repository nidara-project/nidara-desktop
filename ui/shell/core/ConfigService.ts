import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
    configKeys, getConfigEntry, getConfigValue, setConfigValue, describeConfig, type ConfigValue,
} from "./ConfigRegistry"
import agentConfig from "./AgentConfig"
import { t } from "./i18n"

/**
 * NIDARA — the settings, on the session bus: `org.nidara.Config1`
 * ===============================================================
 *
 * The registry agents already use (`describeConfig`/`getConfig`/`setConfig`, ConfigRegistry.ts),
 * served to other PROCESSES — first of all the native Settings of toolkit phase 1
 * (`toolkit/PHASE1.md`, D1), which carries no setting logic of its own: it draws what
 * `Describe` says and calls `Set`. Agents and Settings see the same keys.
 *
 *   Describe() → s          JSON: describeConfig() + `ui` (title, subtitle, control, options'
 *                           labels, slider) + the WHOLE enum (agents get a sample; Settings
 *                           needs every keyboard layout to draw the list)
 *   Get(as) → a{sv}         current values; an empty list = every key
 *   Set(s, v)               through the registry's own validation and setter
 *   Changed(a{sv})          a key's value changed, whoever changed it
 *
 * ── Rules this file keeps ───────────────────────────────────────────────────
 * - A well-known name of its own, `org.nidara.Config`, not the shell's: the service can move
 *   to nidara-sessiond (#574) later with no change to any client.
 * - `Set` from the owner of `org.nidara.Settings` is the Settings window's own path, as the
 *   in-process registry is today (read-only keys excepted: those stay the GTK window's). From ANY other sender it is an agent's `setConfig`: refused
 *   unless Settings → AI allows config writes. That is the user's consent, not a security
 *   boundary — a process of the same user can already write dconf — so this door may not be
 *   wider than the one it sits beside (`setConfig` in app.ts).
 * - `Changed` carries only real changes: a service's `subscribe` re-reads on every one of its
 *   own signals (ThemeManager's covers a dozen keys), so values are compared to the last sent.
 * - Never exported by the Settings process, which registers the same entries: one server.
 */

const NAME = "org.nidara.Config"
const PATH = "/org/nidara/Config"
const SETTINGS_NAME = "org.nidara.Settings"

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
  </interface>
</node>`

const ERROR = "org.nidara.Config1.Error"

const variant = (v: ConfigValue): GLib.Variant =>
    typeof v === "boolean" ? GLib.Variant.new_boolean(v)
        : typeof v === "number" ? GLib.Variant.new_double(v)
        : GLib.Variant.new_string(String(v))

function senderOwns(sender: string | null, name: string): boolean {
    if (!sender) return false
    try {
        const reply = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetNameOwner", new GLib.Variant("(s)", [name]),
            new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, null,
        )
        return (reply.deepUnpack() as [string])[0] === sender
    } catch {
        return false
    }
}

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
    return {
        i18n: ui.i18n,
        title: label(ui.i18n),
        subtitle: label(`${ui.i18n}.desc`),
        control: ui.control ?? (e.type === "boolean" ? "toggle" : e.type === "enum" ? "dropdown" : e.type === "number" ? "slider" : undefined),
        ...(e.enum && ui.optI18n ? { options: e.enum.map(value => ({ value, label: ui.optI18n!(value) })) } : {}),
        ...(s ? {
            slider: {
                unit: s.unit, pct: s.pct, decimals: s.decimals, step: s.step,
                commitOnRelease: s.commitOnRelease, debounce: s.debounce,
                icons: s.icons?.map(i => i.get_file().get_path()),
            },
        } : {}),
        ...(ui.presets ? { presets: ui.presets, presetUnit: ui.presetUnit } : {}),
    }
}

export function describeForSettings(): Record<string, object> {
    const schema = describeConfig() as Record<string, Record<string, unknown>>
    for (const key of Object.keys(schema)) {
        const e = getConfigEntry(key)!
        const entry = schema[key]
        if (e.enum) {
            entry.values = [...e.enum]
            delete entry.valuesTotal
        }
        const ui = uiOf(key)
        if (ui) entry.ui = ui
    }
    return schema
}

export function exportConfigService(): void {
    let exported: any = null
    const sent = new Map<string, ConfigValue>()
    const pending = new Map<string, ConfigValue>()
    let flush = 0
    const changed = (key: string, value: ConfigValue) => {
        if (sent.has(key) && sent.get(key) === value) return
        sent.set(key, value)
        pending.set(key, value)
        // One signal per idle: a ThemeManager change re-reads a dozen keys in one go.
        if (!flush) flush = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            flush = 0
            const values: Record<string, GLib.Variant> = {}
            for (const [k, v] of pending) values[k] = variant(v)
            pending.clear()
            exported?.emit_signal("Changed", new GLib.Variant("(a{sv})", [values]))
            return GLib.SOURCE_REMOVE
        })
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
        SetAsync([key, value]: [string, GLib.Variant], invocation: Gio.DBusMethodInvocation) {
            const fromSettings = senderOwns(invocation.get_sender(), SETTINGS_NAME)
            if (!fromSettings && !agentConfig.allowConfigWrite) {
                invocation.return_dbus_error(`${ERROR}.Denied`, "config writes are disabled — enable them in Settings → AI")
                return
            }
            // Read-only keys (the ai.* gate itself) are refused by the registry for every
            // caller here; the Settings window that changes them is still the GTK one.
            setConfigValue(key, String(value.deepUnpack())).then(result => {
                // setConfigValue answers JSON on success and a sentence otherwise.
                if (result.startsWith("{")) invocation.return_value(null)
                else invocation.return_dbus_error(`${ERROR}.Invalid`, result)
            }).catch(err => invocation.return_dbus_error(`${ERROR}.Failed`, String(err)))
        },
    }

    try {
        exported = Gio.DBusExportedObject.wrapJSObject(IFACE, impl)
        Gio.bus_own_name(
            Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
            (conn: Gio.DBusConnection) => {
                try {
                    exported!.export(conn, PATH)
                } catch (e) {
                    console.error(`[config] could not export ${PATH}:`, e)
                }
            },
            () => console.log(`[config] serving ${NAME}`),
            () => console.warn(`[config] lost ${NAME} — another shell owns it?`),
        )
        // Held for the life of the process: an unreferenced exported object is
        // collected and stops answering with no error.
        ;(exportConfigService as any)._exported = exported
    } catch (e) {
        console.error(`[config] could not export ${NAME}:`, e)
        return
    }
    for (const key of configKeys()) {
        const sub = getConfigEntry(key)!.subscribe
        // The first call is the current value: it seeds `sent`, it is not a change.
        sub?.(v => sent.has(key) ? changed(key, v) : void sent.set(key, v))
    }
}
