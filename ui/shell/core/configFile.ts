import GLib from "gi://GLib"
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

