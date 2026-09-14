import GLib from "gi://GLib"
import Gio from "gi://Gio"

/**
 * Per-key shape guard for the values read back from storage.
 *
 * The schema already refuses a stored value of the wrong type, which catches a
 * string where the code will do arithmetic. It cannot catch the other half: a
 * value of the RIGHT type and the wrong shape. Every
 * module that had a setting like that wrote the check by hand — night-light's
 * `/^\d{2}:\d{2}$/` on the two schedule times, and recording's enums, where a
 * bogus `format` survives the typeof check and then indexes `CODECS` to
 * `undefined`. This is that check, declared beside the shape it belongs to.
 *
 * ⚠️ It runs on every value READ from storage — at start and on every change
 * another process makes — and never on `set`, and that line is deliberate. What
 * is stored is user state we do not control, so a value we cannot use falls back
 * to the default and the desktop starts. A bad value passed to `set` comes from
 * OUR code, and a store that silently swallowed it would hide the bug instead of
 * the call site fixing it — setters that need clamping still clamp at the setter.
 */
export type ConfigValidators<T> = { [K in keyof T]?: (value: T[K]) => boolean }

function isEqual<V>(a: V, b: V): boolean {
    if (Object.is(a, b)) return true
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
        return JSON.stringify(a) === JSON.stringify(b)
    }
    return false
}

export interface SettingsStore<T extends object> {
    get<K extends keyof T>(key: K): T[K]
    set<K extends keyof T>(key: K, value: T[K]): void      // persiste + notifica
    update(patch: Partial<T>): void                        // varias claves, UNA escritura
    subscribe<K extends keyof T>(key: K, cb: (v: T[K]) => void): () => void
    subscribeAll(cb: (key: keyof T) => void): () => void
    readonly all: Readonly<T>
}

/**
 * A settings store whose home is GSettings, `org.nidara.<name>` (#573).
 *
 * It replaced `defineConfig`, the JSON-file store, keeping its interface so each
 * module moved by one line (#573). The difference is the one that matters: the
 * value is no longer owned by THIS process. dconf notifies every process that reads a key, so a change made by
 * `gsettings set`, by another Nidara process or by this one reaches every store
 * of the same schema — and each of them updates its `all` object in place and
 * notifies its subscribers exactly as a local `set` would.
 *
 * Field names are camelCase in TypeScript and kebab-case in the schema
 * (`iconSize` ↔ `icon-size`); the schema lives in `config/gsettings/`.
 *
 * What was measured before this was written (GJS, 2026-09-14):
 *  - `changed` is emitted SYNCHRONOUSLY inside `set_value` in the writing process,
 *    so `set` updates `state` BEFORE writing and the echo finds nothing to do;
 *  - writing a value equal to the stored one emits no `changed` anywhere;
 *  - `delay()` IS PERMANENT: `apply()` commits but leaves the object in delay
 *    mode, so every later `set_value` on it waits for an `apply()` that never
 *    comes. Found by the probe — `update()` on the store's own object silently lost
 *    every write after the first batch. Batches go through a SECOND object, kept in
 *    delay mode for exactly that;
 *  - another process hears a change about 12 ms later;
 *  - a missing schema THROWS (a catchable JS error, not an abort).
 *
 * ⚠️ A SUBSCRIBER HERE RUNS IN EVERY PROCESS THAT BUILT THE STORE. Updating a
 * widget from it is right; a side effect that must happen once for the desktop —
 * writing a Lua file Hyprland reads, restarting a daemon, firing a user hook —
 * must only be wired in the shell. Today the shell is the only process, so this
 * costs nothing yet; it is what #571 (Settings as its own process) relies on.
 *
 * `computed` names fields whose default is only known at run time (the XDG videos
 * folder, whether a GPU render node exists). A computed field the user has never
 * set reads the TypeScript default; its schema default is a placeholder.
 *
 * Failure policy — the desktop must start: a schema that is not installed gives
 * a store that works in memory and persists nothing; a key missing from the
 * schema, or one whose type or default disagrees with `defaults`, is recorded in
 * `settingsSchemaProblems()`. Both are logged, and the headless smoke fails on
 * the second through `scripts/dev/define-config-probe.ts`.
 */
export function defineSettings<T extends object>(
    name: string,
    defaults: T,
    validate?: ConfigValidators<T>,
    options: { computed?: (keyof T)[] } = {},
): SettingsStore<T> {
    const schemaId = `${SCHEMA_ROOT}.${name}`
    const keys = Object.keys(defaults) as (keyof T)[]
    const computed = new Set(options.computed ?? [])

    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true) ?? null
    if (!schema) {
        const problem = `${schemaId}: schema is not installed — settings will not persist`
        schemaProblems.push(problem)
        console.error(`[defineSettings] ${problem}`)
        return memoryStore(schemaId, defaults)
    }

    const settings = new Gio.Settings({ settings_schema: schema })
    // A Gio.Settings nothing references is collected, and its `changed` handler
    // with it. The store's closures do reference it; this makes it not depend on that.
    liveSettings.push(settings)

    const problems: string[] = []
    const kebab = new Map<keyof T, string>()
    const fieldOf = new Map<string, keyof T>()
    const types = new Map<keyof T, string>()
    for (const key of keys) {
        const k = toKebab(String(key))
        if (!schema.has_key(k)) {
            problems.push(`${schemaId}: no key "${k}" for field ${String(key)}`)
            continue
        }
        const type = schema.get_key(k).get_value_type().dup_string()
        if (!typeMatches(type, defaults[key])) {
            problems.push(`${schemaId}.${k}: schema type ${type} does not hold ${JSON.stringify(defaults[key])}`)
            continue
        }
        if (!computed.has(key)) {
            const schemaDefault = schema.get_key(k).get_default_value().recursiveUnpack()
            if (!isEqual(schemaDefault, defaults[key])) {
                problems.push(`${schemaId}.${k}: schema default ${JSON.stringify(schemaDefault)} ≠ code default ${JSON.stringify(defaults[key])}`)
            }
        }
        kebab.set(key, k)
        fieldOf.set(k, key)
        types.set(key, type)
    }
    for (const p of problems) {
        schemaProblems.push(p)
        console.error(`[defineSettings] ${p}`)
    }

    /** The value a field has for the desktop right now. Falls back to the code
     *  default when the stored value fails its validator: a range or a choice list
     *  in the schema catches most of that, a shape like `HH:MM` it cannot. */
    function read<K extends keyof T>(key: K): T[K] {
        const k = kebab.get(key)
        if (!k) return defaults[key]
        if (computed.has(key) && settings.get_user_value(k) === null) return defaults[key]
        const value = settings.get_value(k).recursiveUnpack() as T[K]
        const check = validate?.[key]
        if (check && !check(value)) return defaults[key]
        return value
    }

    function coerce<K extends keyof T>(key: K, value: T[K]): T[K] {
        const type = types.get(key)
        if (type && INTEGER_TYPES.has(type)) return Math.round(Number(value)) as T[K]
        if (type === "d") return Number(value) as T[K]
        return value
    }

    // The batching object for `update` — see "delay() IS PERMANENT" above.
    const batch = new Gio.Settings({ settings_schema: schema })
    batch.delay()
    liveSettings.push(batch)

    function write<K extends keyof T>(key: K, value: T[K], target = settings) {
        const k = kebab.get(key)
        if (!k) return      // a field the schema lacks lives in memory only; already reported
        try {
            target.set_value(k, new GLib.Variant(types.get(key)!, value))
        } catch (e) {
            console.error(`[defineSettings:${schemaId}] Failed to write ${k}:`, e)
        }
    }

    const state: T = { ...defaults }
    for (const key of keys) state[key] = read(key)

    const listeners = makeListeners<T>(schemaId)

    // Every change, whoever made it. Our own writes arrive here too, synchronously,
    // and stop at the equality check because `set` updated `state` first.
    settings.connect("changed", (_s: unknown, k: string) => {
        const key = fieldOf.get(k)
        if (key === undefined) return
        const value = read(key)
        if (isEqual(state[key], value)) return
        state[key] = value
        listeners.notify(key, value)
    })

    return {
        get<K extends keyof T>(key: K): T[K] {
            return state[key]
        },

        set<K extends keyof T>(key: K, value: T[K]): void {
            const v = coerce(key, value)
            if (isEqual(state[key], v)) return
            state[key] = v
            write(key, v)
            listeners.notify(key, v)
        },

        update(patch: Partial<T>): void {
            const changed: { key: keyof T; value: any }[] = []
            for (const key of Object.keys(patch) as (keyof T)[]) {
                if (!(key in defaults) || patch[key] === undefined) continue
                const v = coerce(key, patch[key] as T[keyof T])
                if (isEqual(state[key], v)) continue
                state[key] = v
                changed.push({ key, value: v })
            }
            if (changed.length === 0) return
            for (const { key, value } of changed) write(key, value, batch)
            batch.apply()
            for (const { key, value } of changed) listeners.notify(key, value)
        },

        subscribe: listeners.subscribe,
        subscribeAll: listeners.subscribeAll,

        get all(): Readonly<T> {
            return state
        },
    }
}

const SCHEMA_ROOT = "org.nidara"
const INTEGER_TYPES = new Set(["y", "n", "q", "i", "u", "x", "t"])
const schemaProblems: string[] = []
const liveSettings: InstanceType<typeof Gio.Settings>[] = []

/** Every disagreement between a store and its installed schema found so far. */
export function settingsSchemaProblems(): readonly string[] {
    return schemaProblems
}

const toKebab = (field: string) => field.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

function typeMatches(type: string, value: unknown): boolean {
    if (type === "b") return typeof value === "boolean"
    if (type === "s") return typeof value === "string"
    if (type === "d" || INTEGER_TYPES.has(type)) return typeof value === "number"
    if (type.startsWith("as")) return Array.isArray(value)
    if (type.startsWith("a{")) return typeof value === "object" && value !== null && !Array.isArray(value)
    return false
}

function makeListeners<T extends object>(label: string) {
    const keyListeners = new Map<keyof T, Set<(v: any) => void>>()
    const allListeners = new Set<(key: keyof T) => void>()
    return {
        notify<K extends keyof T>(key: K, value: T[K]) {
            for (const cb of [...(keyListeners.get(key) ?? [])]) {
                try { cb(value) } catch (e) {
                    console.error(`[${label}] Listener error on ${String(key)}:`, e)
                }
            }
            for (const cb of [...allListeners]) {
                try { cb(key) } catch (e) {
                    console.error(`[${label}] All-listener error on ${String(key)}:`, e)
                }
            }
        },
        subscribe<K extends keyof T>(key: K, cb: (v: T[K]) => void): () => void {
            let set = keyListeners.get(key)
            if (!set) {
                set = new Set()
                keyListeners.set(key, set)
            }
            set.add(cb)
            return () => {
                set!.delete(cb)
                if (set!.size === 0) keyListeners.delete(key)
            }
        },
        subscribeAll(cb: (key: keyof T) => void): () => void {
            allListeners.add(cb)
            return () => { allListeners.delete(cb) }
        },
    }
}

/** The no-schema fallback: the desktop starts, nothing is persisted. */
function memoryStore<T extends object>(label: string, defaults: T): SettingsStore<T> {
    const state: T = { ...defaults }
    const listeners = makeListeners<T>(label)
    return {
        get: key => state[key],
        set(key, value) {
            if (isEqual(state[key], value)) return
            state[key] = value
            listeners.notify(key, value)
        },
        update(patch) {
            for (const key of Object.keys(patch) as (keyof T)[]) {
                if (key in defaults && patch[key] !== undefined) this.set(key, patch[key] as T[keyof T])
            }
        },
        subscribe: listeners.subscribe,
        subscribeAll: listeners.subscribeAll,
        get all() { return state },
    }
}

