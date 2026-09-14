import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { readFile, writeFile } from "../../lib/file"

/**
 * Per-key shape guard for the values read back off disk.
 *
 * `loadKnown` already refuses a saved value whose `typeof` disagrees with the
 * default, which catches a string where the code will do arithmetic. It cannot
 * catch the other half: a value of the RIGHT type and the wrong shape. Every
 * module that had a setting like that wrote the check by hand — night-light's
 * `/^\d{2}:\d{2}$/` on the two schedule times, and recording's enums, where a
 * bogus `format` survives the typeof check and then indexes `CODECS` to
 * `undefined`. This is that check, declared beside the shape it belongs to.
 *
 * ⚠️ It runs on LOAD ONLY, and that line is deliberate. The file is user state
 * we do not control, so a value we cannot use falls back to the default and the
 * desktop starts. A bad value passed to `set` comes from OUR code, and a store
 * that silently swallowed it would hide the bug instead of the call site fixing
 * it — setters that need clamping still clamp at the setter.
 */
export type ConfigValidators<T> = { [K in keyof T]?: (value: T[K]) => boolean }

/**
 * Loading a settings JSON without letting it accumulate.
 *
 * Every config module here is the same shape: a `DEFAULTS` object describing the
 * settings that exist, a JSON file under `~/.config/nidara/`, and a `save()` that
 * writes the in-memory object back. The obvious load is `{ ...DEFAULTS, ...data }`
 * — and it is a one-way ratchet: a key that has been RETIRED from `DEFAULTS` is
 * still in the user's file, the spread carries it into the live object, and the
 * next save writes it out again. It never leaves. `region.json` still carried
 * `weekStartsMonday` months after that setting was reverted (`4212a3e5`), and the
 * only reason it did no harm is that nothing read it.
 *
 * That is worse than clutter, because the same mechanism resurrects MEANING. A
 * retired key that later comes back — same name, new semantics — reads a value the
 * user never chose in the new sense, and it will have been sitting in their file
 * for months. The file is user state, but the SHAPE of it belongs to the code.
 *
 * So: keep only what the current shape declares. Two modules already did this by
 * hand (`NotifConfig` after the retired `dndDefault`, `ThemeManager` by loading
 * field-by-field and saving an explicit object); this is the same rule in one
 * place, so the next module gets it for free.
 *
 * ⚠️ NOT for files whose keys ARE the data — `WidgetConfig`'s map is keyed by
 * widget id, so every key is unknown by construction and a spread is right there.
 * The test is whether `DEFAULTS` enumerates the valid keys or merely seeds them.
 */
export function loadKnown<T extends object>(
    defaults: T,
    data: unknown,
    validate?: ConfigValidators<T>,
): T {
    const out = { ...defaults }
    if (!data || typeof data !== "object" || Array.isArray(data)) return out

    for (const key of Object.keys(defaults) as (keyof T)[]) {
        const saved = (data as Record<string, unknown>)[key as string]
        if (saved === undefined || saved === null) continue
        // Shape check as well as name check: a hand-edited file (or a field whose
        // type changed between versions) should fall back to the default rather
        // than put a string where the code will do arithmetic. Objects are taken
        // wholesale — they are the per-key maps (brainModels, brainEndpoints),
        // whose inner keys are data, not shape.
        if (typeof saved !== typeof defaults[key]) continue
        const check = validate?.[key]
        if (check && !check(saved as T[keyof T])) continue
        out[key] = saved as T[keyof T]
    }
    return out
}

function isEqual<V>(a: V, b: V): boolean {
    if (Object.is(a, b)) return true
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
        return JSON.stringify(a) === JSON.stringify(b)
    }
    return false
}

export interface ConfigFileStore<T extends object> {
    get<K extends keyof T>(key: K): T[K]
    set<K extends keyof T>(key: K, value: T[K]): void      // persiste + notifica
    update(patch: Partial<T>): void                        // varias claves, UNA escritura
    subscribe<K extends keyof T>(key: K, cb: (v: T[K]) => void): () => void
    subscribeAll(cb: (key: keyof T) => void): () => void
    readonly all: Readonly<T>
}

/**
 * Single lifecycle owner for a JSON settings file under `~/.config/nidara/`.
 *
 * Provides:
 *  - durable, atomic persistence via `writeFile` (CONSISTENT | DURABLE)
 *  - key-filtered deserialization via `loadKnown` (retired keys drop), with an
 *    optional per-key `validate` for values whose type is right and shape wrong
 *  - equality guard: identical values do not touch the filesystem or notify
 *  - per-key subscription and grouped updates with a single write
 *  - explicit disposer on every subscription
 */
export function defineConfig<T extends object>(
    fileName: string,
    defaults: T,
    validate?: ConfigValidators<T>,
): ConfigFileStore<T> {
    const filePath = `${GLib.get_user_config_dir()}/nidara/${fileName}`
    const state: T = { ...defaults }

    try {
        if (GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
            const raw = JSON.parse(readFile(filePath))
            Object.assign(state, loadKnown(defaults, raw, validate))
        }
    } catch (e) {
        console.error(`[defineConfig:${fileName}] Failed to load:`, e)
    }

    function persist() {
        try {
            writeFile(filePath, JSON.stringify(state, null, 2))
        } catch (e) {
            console.error(`[defineConfig:${fileName}] Failed to persist:`, e)
        }
    }

    const keyListeners = new Map<keyof T, Set<(v: any) => void>>()
    const allListeners = new Set<(key: keyof T) => void>()

    function notifyKey<K extends keyof T>(key: K, value: T[K]) {
        const listeners = keyListeners.get(key)
        if (listeners) {
            for (const cb of [...listeners]) {
                try {
                    cb(value)
                } catch (e) {
                    console.error(`[defineConfig:${fileName}] Listener error on ${String(key)}:`, e)
                }
            }
        }
        for (const cb of [...allListeners]) {
            try {
                cb(key)
            } catch (e) {
                console.error(`[defineConfig:${fileName}] All-listener error on ${String(key)}:`, e)
            }
        }
    }

    return {
        get<K extends keyof T>(key: K): T[K] {
            return state[key]
        },

        set<K extends keyof T>(key: K, value: T[K]): void {
            if (isEqual(state[key], value)) return
            state[key] = value
            persist()
            notifyKey(key, value)
        },

        update(patch: Partial<T>): void {
            const changed: { key: keyof T; value: any }[] = []
            for (const key of Object.keys(patch) as (keyof T)[]) {
                if (!(key in defaults)) continue
                const val = patch[key]
                if (val !== undefined && !isEqual(state[key], val)) {
                    state[key] = val as T[keyof T]
                    changed.push({ key, value: val })
                }
            }
            if (changed.length === 0) return
            persist()
            for (const { key, value } of changed) {
                notifyKey(key, value)
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
                if (set!.size === 0) {
                    keyListeners.delete(key)
                }
            }
        },

        subscribeAll(cb: (key: keyof T) => void): () => void {
            allListeners.add(cb)
            return () => {
                allListeners.delete(cb)
            }
        },

        get all(): Readonly<T> {
            return state
        },
    }
}

/**
 * A settings store whose home is GSettings, `org.nidara.<name>` (#573).
 *
 * Same interface as `defineConfig`, so a module moves by changing one line, and
 * the difference is the one that matters: the value is no longer owned by THIS
 * process. dconf notifies every process that reads a key, so a change made by
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
): ConfigFileStore<T> {
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
function memoryStore<T extends object>(label: string, defaults: T): ConfigFileStore<T> {
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

