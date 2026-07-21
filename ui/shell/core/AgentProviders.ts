// The built-in Assistant's PROVIDER registry — the user-facing vocabulary of the
// brain picker (Settings → AI).
//
// Why this exists: there are only TWO wire protocols (Anthropic's Messages API and
// the OpenAI-compatible /chat/completions shape), but many providers speak them.
// Showing the user "OpenAI-compatible" is jargon — someone holding a Google or
// Mistral key can't tell it's for them. So the UI picks by PROVIDER NAME and this
// table maps each name down to its protocol + endpoint.
//
// The distinction that actually matters (and the reason the keyring attribute is
// the provider id, not the backend): a key belongs to a PROVIDER, not to a
// protocol. Google and Mistral both ride the openai path — if the keyring slot
// were named after the protocol they would overwrite each other's key, and the
// symptom would be a 401 from a provider whose key the user just "saved".
//
// Adding a provider = one row here + one label in i18n. The daemon needs no
// change: the shell writes the resolved backend/endpoint into ai.json for it.
export interface AgentProvider {
    /** Stable id. Persisted in ai.json AND used as the libsecret attribute. */
    id: string
    /** Wire protocol. Only Anthropic is native; everything else is OpenAI-shaped. */
    backend: "anthropic" | "openai"
    /** Base URL for the openai path. "" for Anthropic (the daemon knows its own). */
    endpoint: string
    /** Show the endpoint row. True for Custom (obviously) and for Ollama: 11434 is
     *  only the DEFAULT port — `OLLAMA_HOST` changes it, and pointing at an Ollama
     *  on another machine is common. Hosted providers pin their own URL. */
    editableEndpoint?: boolean
    /** Label comes from i18n rather than the brand table. */
    custom?: boolean
    /** Local runtime: no API key needed, so the key row is hidden. */
    local?: boolean
}

// NO default model ids on purpose (user's call 2026-07-21, once the catalog
// landed). Model ids churn faster than anything else here, so a hardcoded default
// is a liability that ages into a wrong value nobody notices — and now that
// Settings can ASK the provider for its real list, shipping a guess buys nothing.
// A fresh pick starts empty: fetch the catalog, or type the id.
export const AGENT_PROVIDERS: AgentProvider[] = [
    // ── Hosted, key required ────────────────────────────────────────────────
    // DELIBERATELY SHORT (user's call 2026-07-21): the four most people will
    // actually use. An exhaustive provider list is a maintenance treadmill — ids,
    // endpoints and brands all churn — and every extra row is another catalog we'd
    // have to keep working. Anything else goes through "Other API endpoint…", which
    // reaches any OpenAI-compatible service. Do NOT grow this list by default;
    // adding a row should mean "enough users asked", not "it exists".
    { id: "anthropic",  backend: "anthropic", endpoint: "" },
    { id: "openai",     backend: "openai",    endpoint: "https://api.openai.com/v1" },
    { id: "google",     backend: "openai",    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai" },
    // SpaceXAI — xAI rebranded 2026-07-06 (Grok, and the developer API, kept their
    // names and endpoint; verified against docs.x.ai, not from memory).
    { id: "spacexai",   backend: "openai",    endpoint: "https://api.x.ai/v1" },
    // ── Local / self-hosted (no API key) ────────────────────────────────────
    // Listed last so the dropdown reads as two families without needing section
    // headers: hosted services above, run-it-yourself below. `local` is what
    // actually removes the API-key row — the split is not cosmetic.
    { id: "ollama",     backend: "openai",    endpoint: "http://localhost:11434/v1",  local: true, editableEndpoint: true },
    { id: "localhost",  backend: "openai",    endpoint: "http://localhost:8080/v1",          local: true, editableEndpoint: true },
    // Escape hatch for a keyed endpoint we don't have a row for (a corporate
    // gateway, a proxy, a provider added after this release).
    { id: "custom",     backend: "openai",    endpoint: "https://", custom: true, editableEndpoint: true },
]

export function providerById(id: string): AgentProvider | null {
    return AGENT_PROVIDERS.find(p => p.id === id) ?? null
}
