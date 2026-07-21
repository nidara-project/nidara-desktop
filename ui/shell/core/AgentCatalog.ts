import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Secret from "gi://Secret"
import { AgentProvider } from "./AgentProviders"

// Model CATALOG — asks the provider which models it actually offers, so the model
// field can be picked from a list instead of typed from memory.
//
// Why this exists: hardcoding model ids ages badly (they churn faster than
// anything else in the provider table), and a wrong default is a dead end for a
// user who doesn't know the right string. The provider already knows the answer —
// both wire protocols expose a catalog endpoint — so we ask.
//
// Transport is `curl` in a subprocess, the same house pattern bin/nidara-agent
// uses for SSE: no new dependency, and the shell never blocks (async from the
// keyring lookup through to the parse).

const SCHEMA = Secret.Schema.new(
    "org.nidara.Assistant",
    Secret.SchemaFlags.NONE,
    { provider: Secret.SchemaAttributeType.STRING },
)

/** Ids that are clearly not chat models. Best-effort and deliberately shallow:
 *  a catalog listing embeddings/audio/image endpoints alongside chat ones is
 *  common (OpenAI), but the rules differ per provider and age badly — so this
 *  only drops the obvious, and anything it fails to drop is still selectable
 *  rather than hidden. Never filter so hard that a valid model disappears. */
const NON_CHAT = /(embed|whisper|tts|audio|speech|image|dall-?e|moderation|rerank|vision-encoder)/i

function parseModels(json: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    try {
        const body = JSON.parse(json)
        // Both protocols answer `{ data: [ { id }, … ] }` — Anthropic adds
        // display_name, OpenAI-compatible servers vary in the extra fields.
        const rows = Array.isArray(body?.data) ? body.data : []
        for (const r of rows) {
            const id = typeof r?.id === "string" ? r.id : ""
            if (!id || seen.has(id) || NON_CHAT.test(id)) continue
            seen.add(id)
            out.push(id)
        }
    } catch {
        return []
    }
    return out.sort()
}

/** Read the stored key without blocking the main loop (a locked keyring can put a
 *  prompt up — see the note in Settings → AI). */
function withKey(provider: string, done: (key: string | null) => void): void {
    try {
        Secret.password_lookup(SCHEMA, { provider }, null, (_s: any, res: any) => {
            let k: string | null = null
            try { k = Secret.password_lookup_finish(res) } catch { k = null }
            done(k)
        })
    } catch {
        done(null)
    }
}

export interface CatalogResult {
    models: string[]
    /** Populated when the catalog could not be read — shown to the user as-is. */
    error: string
}

/**
 * Fetch the provider's model list. Never throws and never blocks: a failure comes
 * back as `error` and the caller keeps its free-text field, which stays the source
 * of truth. `endpoint` is passed in rather than read from the provider so a Custom
 * or relocated-Ollama URL works too.
 */
export function fetchModels(
    p: AgentProvider,
    endpoint: string,
    done: (r: CatalogResult) => void,
): void {
    withKey(p.id, (key) => {
        // Anthropic speaks its own Models API; everything else is the OpenAI shape.
        const anthropic = p.backend === "anthropic"
        const url = anthropic
            ? "https://api.anthropic.com/v1/models"
            : `${endpoint.replace(/\/+$/, "")}/models`

        // --fail-with-body: report HTTP errors on stderr (a server with no catalog
        // otherwise looks like an empty answer) while KEEPING the body, which is
        // where a provider puts its own message on a 401.
        const argv = ["curl", "-sS", "--fail-with-body", "--max-time", "15", url]
        if (anthropic) {
            argv.push("-H", `x-api-key: ${key ?? ""}`, "-H", "anthropic-version: 2023-06-01")
        } else if (key) {
            // Local servers (Ollama) usually take no key — only send one if stored.
            argv.push("-H", `Authorization: Bearer ${key}`)
        }

        let proc: Gio.Subprocess
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
        } catch (e) {
            done({ models: [], error: String(e) })
            return
        }
        proc.communicate_utf8_async(null, null, (_s: any, res: any) => {
            let out = "", err = ""
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res)
                out = stdout ?? ""
                err = stderr ?? ""
            } catch (e) {
                done({ models: [], error: String(e) })
                return
            }
            const models = parseModels(out)
            if (models.length) { done({ models, error: "" }); return }
            // No models: surface the provider's own message when it sent one (an
            // auth error reads far better than "nothing found").
            let msg = err.trim()
            try {
                const body = JSON.parse(out)
                msg = body?.error?.message || body?.message || msg
            } catch {}
            done({ models: [], error: msg || "no models returned" })
        })
    })
}

/** True where asking is worth a round trip. Local servers answer without a key;
 *  hosted ones need one stored first, so the caller can explain that up front. */
export function catalogNeedsKey(p: AgentProvider): boolean {
    return !p.local
}

export { GLib }
