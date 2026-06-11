// Typed registry of agent-readable/-writable shell settings — the data half of
// the `getConfig`/`setConfig`/`describeConfig` IPC surface (see app.ts).
// Same pattern as ShellActions: this module only defines the registry; the
// entries are registered from config-entries.ts at main() time, so core/ never
// imports widget code (dock settings live in surfaces/dock/state.ts).
//
// Every entry is self-describing (desc/type/constraints) — `describeConfig`
// serves it as JSON, so agents discover the whole configurable surface without
// reading source. Setters delegate to the owning service, which validates,
// persists and notifies its consumers exactly as if Settings had been used.

export type ConfigValue = boolean | number | string

export interface ConfigEntry {
    desc: string
    type: "boolean" | "number" | "enum" | "string"
    /** valid values when type === "enum" */
    enum?: readonly string[]
    /** inclusive bounds when type === "number" */
    min?: number
    max?: number
    /** false → setConfig refuses even when writes are allowed (e.g. the ai.* gate itself) */
    writable?: boolean
    get(): ConfigValue
    set?(v: ConfigValue): void
}

const entries: Record<string, ConfigEntry> = {}

export function registerConfig(key: string, entry: ConfigEntry) {
    entries[key] = entry
}

export function configKeys(): string[] {
    return Object.keys(entries).sort()
}

/** Machine-readable schema + current values — what `describeConfig` serves. */
export function describeConfig() {
    const out: Record<string, object> = {}
    for (const key of configKeys()) {
        const e = entries[key]
        out[key] = {
            desc: e.desc,
            type: e.type,
            ...(e.enum ? { values: e.enum } : {}),
            ...(e.min !== undefined ? { min: e.min } : {}),
            ...(e.max !== undefined ? { max: e.max } : {}),
            writable: e.writable !== false && !!e.set,
            value: e.get(),
        }
    }
    return out
}

// Plain optional-field result (not a discriminated union): tsconfig has
// strict:false, under which tsc does not narrow `r.ok ? r.value : r.error`.
export interface ConfigResult {
    ok: boolean
    value?: ConfigValue
    error?: string
}

export function getConfigValue(key: string): ConfigResult {
    const e = entries[key]
    if (!e) return { ok: false, error: `unknown key: ${key} — try \`describeConfig\`` }
    return { ok: true, value: e.get() }
}

export function getAllConfigValues(): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {}
    for (const key of configKeys()) out[key] = entries[key].get()
    return out
}

/** Parse + validate a raw string against the entry's declared type/constraints. */
function parseValue(e: ConfigEntry, raw: string): ConfigResult {
    switch (e.type) {
        case "boolean": {
            const low = raw.toLowerCase()
            if (["true", "on", "1", "yes"].includes(low)) return { ok: true, value: true }
            if (["false", "off", "0", "no"].includes(low)) return { ok: true, value: false }
            return { ok: false, error: `expected a boolean (true/false), got: ${raw}` }
        }
        case "number": {
            const n = Number(raw)
            if (Number.isNaN(n)) return { ok: false, error: `expected a number, got: ${raw}` }
            if (e.min !== undefined && n < e.min) return { ok: false, error: `${n} is below the minimum (${e.min})` }
            if (e.max !== undefined && n > e.max) return { ok: false, error: `${n} is above the maximum (${e.max})` }
            return { ok: true, value: n }
        }
        case "enum": {
            if (!e.enum?.includes(raw))
                return { ok: false, error: `invalid value: ${raw} — valid: ${e.enum?.join(", ")}` }
            return { ok: true, value: raw }
        }
        case "string":
            return { ok: true, value: raw }
    }
}

/**
 * Validate and apply. Returns a human/agent-readable result string.
 * NOTE: the allow-writes gate (AgentConfig) is enforced by the IPC layer in
 * app.ts — this function is the trusted path Settings/internal code may use.
 */
export function setConfigValue(key: string, raw: string): string {
    const e = entries[key]
    if (!e) return `unknown key: ${key} — try \`describeConfig\``
    if (e.writable === false || !e.set)
        return `read-only key: ${key} (changeable only from the Settings window)`
    const parsed = parseValue(e, raw)
    if (!parsed.ok) return `invalid value for ${key}: ${parsed.error}`
    try {
        e.set(parsed.value as ConfigValue)
        return JSON.stringify({ key, value: e.get() })
    } catch (err) {
        console.error(`[ConfigRegistry] set ${key} failed:`, err)
        return `error applying ${key}: ${err}`
    }
}
