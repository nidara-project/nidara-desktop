import GLib from "gi://GLib"
import { providerById } from "./AgentProviders"
import { defineConfig } from "./configFile"

// Governance for the agent-facing surface (Settings → AI). This gates the
// OFFICIAL door (`nidara-ipc setConfig`, future MCP server) — it is a consent
// layer, not a security boundary: any local process can still edit config
// files directly, same as the user. Reading state (dumpState/getConfig) is
// always allowed; it powers nidara-doctor and diagnostics.

interface AgentSettings {
    allowConfigWrite: boolean  // agents may change settings via setConfig, default true
    allowScreenshot: boolean   // agents may capture the screen via the screenshot IPC, default true
    allowWindowClose: boolean  // agents may CLOSE windows via the closeWindow IPC, default true.
                               // The rest of the window/workspace cluster stays ungated on purpose
                               // (focus/move/float/layout are all reversible); closing is the one
                               // op that can destroy work, so it gets its own switch. Default TRUE
                               // because it asks the window to close rather than killing it — an
                               // app with unsaved work still gets to prompt — and "close the
                               // browser" is a reasonable thing to ask an assistant for.
    allowMcp: boolean          // nidara-mcp serves tools to MCP clients, default true
    allowComputerUse: boolean      // agents may PERCEIVE third-party apps via AT-SPI (nidara-a11y),
                                   // default FALSE — reaches outside the shell's own surface
                                   // (privacy-sensitive, ≈ the screenshot gate)
    allowComputerControl: boolean  // agents may ACT on third-party apps via AT-SPI do_action
                                   // (nidara-act), default FALSE — requires allowComputerUse;
                                   // while granted the bar shows a kill-switch indicator: subtle
                                   // "armed" when idle, a bright "active" pulse while acting
                                   // (see computerActing / pulseComputerAction)

    // ── The built-in Assistant's FILE access (tier 1) ───────────────────────
    // Read live by bin/nidara-agent (re-reads ai.json per turn). These gate the
    // daemon's own file tools, NOT an IPC action: external MCP clients already
    // bring their own file tools, so there is nothing to mirror onto that surface.
    // The frontier itself (which paths) lives in the daemon — this is only the
    // on/off consent. See skills/customize/SKILL.md for the ownership model.
    allowFileRead: boolean     // assistant may READ Nidara's own config, the shipped
                               // defaults in /usr/share/nidara, and the shell log.
                               // Default TRUE: same domain as dumpState/screenshot —
                               // Nidara reading Nidara. Note it does send those file
                               // contents to the configured model provider.
    allowFileWrite: boolean    // assistant may WRITE the handful of files no running
                               // service owns (hyprland-user.lua, hypridle.conf).
                               // Default FALSE, and it is NOT the same risk class as
                               // allowConfigWrite: those files exist to hold
                               // hl.exec_cmd(…) / on-timeout commands, so writing them
                               // schedules arbitrary commands for the next session.
                               // Legible and revertible (plain text, git-tracked), but
                               // execution nonetheless — hence opt-in, like computer-use.

    // ── The built-in Assistant's BRAIN (BYOK) ───────────────────────────────
    // Which LLM the native assistant (surfaces/island Agent mode + bin/nidara-agent)
    // talks to. NOT a gate — these are plain config values the daemon re-reads per
    // turn from ai.json. "" = no brain configured (assistant shows an empty state).
    // The API KEY is NEVER stored here — it lives in the DE keyring (libsecret,
    // schema org.nidara.Assistant, attribute provider). See Settings → AI.
    //
    // brainProvider is what the USER picks (a name: anthropic/openai/google/…, see
    // core/AgentProviders.ts). brainBackend/brainEndpoint are DERIVED from it and
    // written alongside so bin/nidara-agent stays dumb: it reads the protocol and
    // URL it needs without carrying a provider table of its own.
    brainProvider: string                       // "" = off; else a provider id from AGENT_PROVIDERS
    brainBackend: "" | "anthropic" | "gemini" | "openai"  // derived wire protocol ("" = off)
    brainModel: string                          // model id of the ACTIVE provider (what the daemon reads)
    brainEndpoint: string                       // base URL (ignored for anthropic, which knows its own)
    /** Per-provider model memory, keyed by provider id. Switching providers restores
     *  the model you last used there instead of carrying a wrong one across (picking
     *  Ollama used to leave `claude-opus-4-8` in the field). */
    brainModels: Record<string, string>
    /** Same for endpoints, so an edited URL survives a round trip through another
     *  provider — only meaningful where the endpoint is editable (Ollama, Custom). */
    brainEndpoints: Record<string, string>

    /** Glow the focused window's border while the Assistant is running a turn
     *  (core/AgentGlow.ts). Not a gate — a visual preference, and the one setting
     *  in this file that changes something OUTSIDE the shell: it makes Nidara the
     *  owner of Hyprland's `decoration:glow`. Off is for users who set that up
     *  themselves in hyprland-user.lua and would rather keep it. */
    assistantGlow: boolean
}

const DEFAULTS: AgentSettings = {
    allowConfigWrite: true,
    allowScreenshot: true,
    allowWindowClose: true,
    allowMcp: true,
    allowComputerUse: false,
    allowComputerControl: false,
    allowFileRead: true,
    allowFileWrite: false,
    brainProvider: "",
    brainBackend: "",
    brainModel: "",
    brainEndpoint: "http://localhost:11434/v1",
    brainModels: {},
    brainEndpoints: {},
    assistantGlow: true,
}

const BACKENDS: readonly AgentSettings["brainBackend"][] = ["", "anthropic", "gemini", "openai"]

const config = defineConfig<AgentSettings>("ai.json", DEFAULTS, {
    // The one string in this file the daemon BRANCHES on: bin/nidara-agent picks
    // its wire protocol from it. Every other string here is free-form (a model
    // id, a URL), and `loadKnown`'s typeof check is the right guard for those.
    brainBackend: v => BACKENDS.includes(v),
})

const _settings: Readonly<AgentSettings> = config.all

// RE-DERIVE the wire protocol from the provider table on every load.
// brainBackend/brainEndpoint are documented as derived from brainProvider, but
// they are also persisted — and only recomputed inside setBrainProvider(). So a
// provider that changes protocol upstream (Google moved compat → native on
// 2026-07-22) would keep hitting the OLD path out of a stale file until the user
// happened to re-pick it in Settings, with no symptom to explain why. The table
// is the source of truth; a derived field must never outlive it.
//
// This now PERSISTS the correction rather than only fixing it in memory, and the
// store's equality guard is what makes that free: it writes on the boot where the
// value actually moved, and never again.
{
    const p = providerById(_settings.brainProvider)
    if (p) {
        config.update({
            brainBackend: p.backend,
            // An editable endpoint is the USER's value — never clobber it.
            ...(p.editableEndpoint ? {} : { brainEndpoint: p.endpoint }),
        })
    }
}

// Notification fan-in. This module has ONE event its file cannot carry — the
// transient computer-use pulse below — so `onChange` is the union of "a setting
// changed" and "an action just landed", which is what every subscriber already
// assumed. The store feeds the same set rather than being a second channel.
const _listeners = new Set<() => void>()
const _notify = () => _listeners.forEach(fn => fn())
config.subscribeAll(_notify)

// Transient computer-use ACTIVITY — distinct from allowComputerControl (the
// persistent PERMISSION). Lit by pulseComputerAction() when a real action lands
// (the standalone tools ping `nidara-ipc notifyComputerAction`), then decays.
// The bar indicator reads both: "armed" = permitted-but-idle, "active" = acting.
/** Perception is useless while the a11y stack is globally off, and GTK4 apps
 *  only fully populate their AT-SPI tree when it is on. Best-effort; never
 *  flipped back off on disable (other assistive tech may want it). */
function enableToolkitAccessibility() {
    try {
        GLib.spawn_command_line_async(
            "gsettings set org.gnome.desktop.interface toolkit-accessibility true",
        )
    } catch (e) {
        console.error("[AgentConfig] enabling toolkit-accessibility failed:", e)
    }
}

let _acting = false
let _actingTimer = 0
const ACTING_DECAY_MS = 4000

export const agentConfig = {
    get allowConfigWrite() { return _settings.allowConfigWrite },
    get allowScreenshot() { return _settings.allowScreenshot },
    get allowWindowClose() { return _settings.allowWindowClose },
    get allowMcp() { return _settings.allowMcp },
    get allowComputerUse() { return _settings.allowComputerUse },
    get allowComputerControl() { return _settings.allowComputerControl },
    get allowFileRead() { return _settings.allowFileRead },
    get allowFileWrite() { return _settings.allowFileWrite },

    get brainProvider() { return _settings.brainProvider },
    get brainBackend() { return _settings.brainBackend },
    get brainModel() { return _settings.brainModel },
    get brainEndpoint() { return _settings.brainEndpoint },
    get assistantGlow() { return _settings.assistantGlow },

    // True for ACTING_DECAY_MS after the most recent computer-use action fired.
    get computerActing() { return _acting },

    // Called when a real action lands (via the notifyComputerAction IPC). Lights
    // the active state and (re)arms the decay timer so a burst of actions keeps it
    // lit; the indicator falls back to "armed" once actions stop. Notifies listeners.
    pulseComputerAction() {
        _acting = true
        if (_actingTimer) GLib.source_remove(_actingTimer)
        _actingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACTING_DECAY_MS, () => {
            _acting = false
            _actingTimer = 0
            _notify()
            return GLib.SOURCE_REMOVE
        })
        _notify()
    },

    // core/AgentGlow.ts listens on onChange, so turning this off mid-turn takes
    // the glow away immediately rather than at the end of the turn.
    setAssistantGlow(val: boolean) {
        config.set("assistantGlow", val)
    },

    setAllowConfigWrite(val: boolean) {
        config.set("allowConfigWrite", val)
    },

    setAllowScreenshot(val: boolean) {
        config.set("allowScreenshot", val)
    },

    setAllowWindowClose(val: boolean) {
        config.set("allowWindowClose", val)
    },

    // Read live by the standalone nidara-mcp process (it re-reads
    // ai.json on every tool call), so flipping this needs no restarts.
    setAllowMcp(val: boolean) {
        config.set("allowMcp", val)
    },

    // Read live by the standalone nidara-a11y helper (re-reads ai.json per
    // call). Enabling it also turns on toolkit-accessibility — the capability is
    // useless while the a11y stack is globally off, and GTK4 apps only fully
    // populate their AT-SPI tree when it's on. Best-effort; never flipped back
    // off on disable (it may be wanted by other assistive tech).
    setAllowComputerUse(val: boolean) {
        config.set("allowComputerUse", val)
        if (val) enableToolkitAccessibility()
    },

    // Read live by the standalone nidara-act helper + the do_app_action MCP
    // tool (both re-read ai.json per call). Control REQUIRES perception: enabling
    // it implies allowComputerUse (which also flips on toolkit-accessibility) —
    // you can't drive what you can't see. The shell renders a bar indicator +
    // kill switch while this is on.
    setAllowComputerControl(val: boolean) {
        const implyUse = val && !_settings.allowComputerUse
        // One write for both gates: a crash between them used to be able to leave
        // control granted without the perception it requires.
        config.update(implyUse
            ? { allowComputerControl: val, allowComputerUse: true }
            : { allowComputerControl: val })
        if (implyUse) enableToolkitAccessibility()
    },

    // Read live by bin/nidara-agent (re-reads ai.json per turn), so flipping
    // these takes effect on the next message with no restart.
    setAllowFileRead(val: boolean) {
        // Writing without reading is how you clobber a file someone else lives
        // in: every write path in the daemon re-reads first (the skill makes it a
        // rule). Revoking read therefore revokes write too, rather than leaving a
        // combination that can only corrupt — and both land in ONE write.
        config.update(val
            ? { allowFileRead: true }
            : { allowFileRead: false, allowFileWrite: false })
    },

    // Write REQUIRES read, mirroring allowComputerControl → allowComputerUse:
    // you can't safely edit what you can't see.
    setAllowFileWrite(val: boolean) {
        config.update(val
            ? { allowFileWrite: true, allowFileRead: true }
            : { allowFileWrite: false })
    },

    // ── Assistant brain setters ─────────────────────────────────────────────
    // Read live by bin/nidara-agent (re-reads ai.json per turn), so changing the
    // brain needs no restart. The API key is handled separately (keyring), never here.
    /** Pick a provider by id. Resolves the wire backend + endpoint and restores the
     *  model last used with THAT provider (falling back to its default), so the three
     *  derived fields the daemon reads are always consistent with the pick. */
    setBrainProvider(id: string) {
        const p = providerById(id)
        if (!p) {
            config.update({ brainProvider: "", brainBackend: "" })
            return
        }
        // All four derived fields in ONE write, because a half-applied provider is
        // exactly the state bin/nidara-agent cannot make sense of: it re-reads this
        // file per turn and would find a backend that disagrees with its endpoint.
        config.update({
            brainProvider: p.id,
            brainBackend: p.backend,
            // No fallback default: an unset model is an honest empty state the user
            // fills from the catalog, not a stale guess pretending to be configured.
            brainModel: _settings.brainModels[p.id] || "",
            // Editable-endpoint providers (Ollama, Custom) restore the URL the user
            // last set for THEM; hosted providers are always pinned to their own.
            brainEndpoint: p.editableEndpoint
                ? (_settings.brainEndpoints[p.id] || p.endpoint)
                : p.endpoint,
        })
    },

    /** Empty is a valid value: clearing the field must actually clear it, and must
     *  also drop the per-provider memory — otherwise the old id reappears the next
     *  time you come back to this provider (user-caught 2026-07-21: "mock" kept
     *  coming back). */
    setBrainModel(val: string) {
        const provider = _settings.brainProvider
        if (!provider) {
            config.set("brainModel", val)
            return
        }
        // A NEW object, never the stored one mutated in place: the store compares
        // objects by value to decide whether anything moved, so handing it back
        // the same reference it already holds would read as "unchanged" and
        // persist nothing.
        const brainModels = { ..._settings.brainModels }
        if (val) brainModels[provider] = val
        else delete brainModels[provider]
        config.update({ brainModel: val, brainModels })
    },

    setBrainEndpoint(val: string) {
        const provider = _settings.brainProvider
        if (!provider) {
            config.set("brainEndpoint", val)
            return
        }
        // Copied, not mutated — see setBrainModel.
        config.update({
            brainEndpoint: val,
            brainEndpoints: { ..._settings.brainEndpoints, [provider]: val },
        })
    },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default agentConfig
