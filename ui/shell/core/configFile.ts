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
export function loadKnown<T extends object>(defaults: T, data: unknown): T {
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
        out[key] = saved as T[keyof T]
    }
    return out
}
