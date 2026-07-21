import { Gtk } from "ags/gtk4"
import Secret from "gi://Secret"
import { listGroup, pageBox, toggleRow, createRow, createStackedRow, dropdownRow, staticLabel } from "../SettingsHelpers"
import { NidaraButton } from "../../../../lib/nidara-kit"
import agentConfig from "../../../core/AgentConfig"
import { AGENT_PROVIDERS, providerById } from "../../../core/AgentProviders"
import { fetchModels, catalogNeedsKey } from "../../../core/AgentCatalog"
import { configKeys } from "../../../core/ConfigRegistry"
import { t } from "../../../core/i18n"

// The built-in Assistant's API key lives in the DE keyring (libsecret), never in
// ai.json. One entry per PROVIDER (attribute `provider`), not per wire protocol:
// a key belongs to the company that issued it, and OpenAI/Google/SpaceXAI (plus
// anything behind "Other API endpoint…") all ride the same openai-compatible path
// — keyed by protocol they would overwrite each other's key and the user would get
// a 401 from a provider whose key they just saved. bin/nidara-agent reads it back
// with the same schema. All calls are
// fail-soft: a Nidara session may have no Secret Service running yet (gnome-keyring
// is unlocked at login via PAM — see install.sh), and the page must never crash the
// shell when the keyring is unavailable.
// Brand names — deliberately NOT translated (proper nouns). Only "Off", "Custom"
// and the "(local)" qualifier on Ollama go through i18n.
const PROVIDER_NAMES: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google (Gemini)",
    spacexai: "SpaceXAI (Grok)",
}

const KEY_SCHEMA = Secret.Schema.new(
    "org.nidara.Assistant",
    Secret.SchemaFlags.NONE,
    { provider: Secret.SchemaAttributeType.STRING },
)

function keyringAvailable(): boolean {
    // A lookup for a non-existent attribute returns null when the service is up and
    // throws when it's down — the cheapest liveness probe.
    try {
        Secret.password_lookup_sync(KEY_SCHEMA, { provider: "__probe__" }, null)
        return true
    } catch {
        return false
    }
}

function hasKey(provider: string): boolean {
    if (!provider) return false
    try {
        return !!Secret.password_lookup_sync(KEY_SCHEMA, { provider }, null)
    } catch {
        return false
    }
}

// Writes are ASYNC on purpose — this is not a style preference. Storing a secret can
// put a PASSWORD DIALOG up (gcr-prompter, activated on demand) whenever the login
// keyring has to be created or unlocked — i.e. on any session without PAM
// auto-unlock, and the very first time on any session. The call does not return
// until the user answers, so the sync variant would block the GTK main loop and
// freeze the WHOLE SHELL for as long as that dialog sits there — measured
// 2026-07-21 on a box that had just installed gnome-keyring. Reads stay sync: a
// lookup answers immediately even with no keyring at all (it reports "not found"),
// so opening this page is safe.
function storeKey(provider: string, key: string, done: (ok: boolean) => void): void {
    try {
        Secret.password_store(
            KEY_SCHEMA, { provider }, Secret.COLLECTION_DEFAULT,
            `Nidara Assistant — ${provider}`, key, null,
            (_src: any, res: any) => {
                let ok = false
                try { ok = Secret.password_store_finish(res) } catch (e) {
                    console.error("[Ai] keyring store failed:", e)
                }
                done(ok)
            },
        )
    } catch (e) {
        console.error("[Ai] keyring store failed:", e)
        done(false)
    }
}

function clearKey(provider: string, done: () => void): void {
    try {
        Secret.password_clear(KEY_SCHEMA, { provider }, null, (_src: any, res: any) => {
            try { Secret.password_clear_finish(res) } catch (e) {
                console.error("[Ai] keyring clear failed:", e)
            }
            done()
        })
    } catch (e) {
        console.error("[Ai] keyring clear failed:", e)
        done()
    }
}

// Settings → AI: governance of the agent-facing surface, plus the built-in
// Assistant's brain. Groups, one concept each: the ASSISTANT (which LLM it talks
// to, BYOK) · what agents may do to THIS desktop (shell-scoped, default on) · what
// they may do to OTHER apps (computer-use, escalating, default off) · the MCP
// channel (server toggle + connection file — a transport, not a permission) · and
// read-only interface facts. Every row must gate, drive, or report something REAL —
// no placeholder toggles.
export default function AiPage() {
    const page = pageBox("ai-page")

    // ── Assistant — the built-in conversational agent's brain (BYOK) ─────────
    const brainGroup = listGroup(t("settings.ai.brain.group"))

    // Provider picker — by NAME, not by wire protocol. The protocol (anthropic vs
    // openai-compatible) stays internal: AgentConfig.setBrainProvider derives it,
    // plus the endpoint and the remembered model. Provider names are proper nouns,
    // so only "Off" and "Custom" are translated.
    const PROVIDERS: Array<{ id: string; label: string }> = [
        { id: "", label: t("settings.ai.brain.provider.off") },
        ...AGENT_PROVIDERS.map(p => ({
            id: p.id,
            label: p.id === "custom"    ? t("settings.ai.brain.provider.custom")
                : p.id === "localhost" ? t("settings.ai.brain.provider.localhost")
                : p.id === "ollama"    ? t("settings.ai.brain.provider.ollama")
                : PROVIDER_NAMES[p.id] ?? p.id,
        })),
    ]
    const labelFor = (id: string) => PROVIDERS.find(b => b.id === id)?.label ?? PROVIDERS[0].label
    const idFor = (label: string) => PROVIDERS.find(b => b.label === label)?.id ?? ""

    // ── Model row: free text + an optional catalog fetched from the provider ────
    // The ENTRY stays the source of truth. The dropdown is an aid: it appears only
    // after a successful fetch and just fills the entry. That ordering matters —
    // a catalog can fail (no key, no network, a server with no /models) and the
    // user must still be able to type an id, so nothing is ever gated on it.
    const modelEntry = new Gtk.Entry({
        text: agentConfig.brainModel, hexpand: true,
        placeholder_text: t("settings.ai.brain.model.placeholder"),
    })
    // Unlike the other entries, an EMPTY value commits: clearing the model must
    // actually clear it. Reverting to the stored value on blank (the entryRow
    // convention) made a deleted id reappear on focus-out — user-caught 2026-07-21.
    const commitModel = () => {
        const v = modelEntry.get_text().trim()
        if (v !== agentConfig.brainModel) agentConfig.setBrainModel(v)
    }
    modelEntry.connect("activate", commitModel)
    const modelFocus = new Gtk.EventControllerFocus()
    modelFocus.connect("leave", commitModel)
    modelEntry.add_controller(modelFocus)

    const modelList = new Gtk.StringList({ strings: [] })
    const modelDrop = new Gtk.DropDown({ model: modelList, visible: false, valign: Gtk.Align.CENTER })
    let suppressDropCb = false
    modelDrop.connect("notify::selected", () => {
        if (suppressDropCb) return
        const item = modelList.get_string(modelDrop.selected)
        if (item) { modelEntry.set_text(item); commitModel() }
    })

    const fetchBtn = NidaraButton({ label: t("settings.ai.brain.model.fetch"), pill: true })
    const modelStatus = new Gtk.Label({
        css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.START, xalign: 0,
        wrap: true, visible: false,
    })

    fetchBtn.connect("clicked", () => {
        const p = providerById(agentConfig.brainProvider)
        if (!p) return
        // A hosted catalog is authenticated: say so plainly instead of firing a
        // request that can only come back as a 401.
        if (catalogNeedsKey(p) && !hasKey(p.id)) {
            modelDrop.visible = false
            modelStatus.visible = true
            modelStatus.label = t("settings.ai.brain.model.needkey")
            return
        }
        fetchBtn.sensitive = false
        modelStatus.visible = true
        modelStatus.label = t("settings.ai.brain.model.fetching")
        fetchModels(p, agentConfig.brainEndpoint, (r) => {
            fetchBtn.sensitive = true
            if (r.models.length) {
                suppressDropCb = true
                while (modelList.get_n_items() > 0) modelList.remove(0)
                r.models.forEach(m => modelList.append(m))
                // Preselect the model already configured, if the catalog has it.
                const idx = r.models.indexOf(agentConfig.brainModel)
                modelDrop.selected = idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION
                suppressDropCb = false
                modelDrop.visible = true
                modelStatus.visible = false
            } else {
                modelDrop.visible = false
                modelStatus.label = t("settings.ai.brain.model.failed").replace("%s", r.error)
            }
        })
    })

    const modelLine = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    modelLine.append(modelEntry); modelLine.append(modelDrop); modelLine.append(fetchBtn)
    const modelBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
    modelBox.append(modelLine); modelBox.append(modelStatus)
    const model = {
        row: createStackedRow(t("settings.ai.brain.model"), t("settings.ai.brain.model.desc"), modelBox),
        entry: modelEntry,
    }
    // Stacked too: a URL in the trailing slot is a narrow stub with the description
    // wrapping to two lines beside it — the same squeeze as the key field.
    const endpointEntry = new Gtk.Entry({ text: agentConfig.brainEndpoint, hexpand: true })
    const commitEndpoint = () => {
        const v = endpointEntry.get_text().trim()
        if (v && v !== agentConfig.brainEndpoint) agentConfig.setBrainEndpoint(v)
        else if (!v) endpointEntry.set_text(agentConfig.brainEndpoint)
    }
    endpointEntry.connect("activate", commitEndpoint)
    const endpointFocus = new Gtk.EventControllerFocus()
    endpointFocus.connect("leave", commitEndpoint)
    endpointEntry.add_controller(endpointFocus)
    const endpoint = {
        row: createStackedRow(t("settings.ai.brain.endpoint"), t("settings.ai.brain.endpoint.desc"), endpointEntry),
        entry: endpointEntry,
    }

    // API key row: a password entry + save/clear, status carried in the placeholder
    // (the stored key is never re-shown).
    const keyEntry = new Gtk.PasswordEntry({ show_peek_icon: true, valign: Gtk.Align.CENTER, width_chars: 16 })
    // Labelled "Save key" / "Forget key", not "Save" / "Clear": this is the ONLY
    // button on a page where every other field commits on Enter/focus-out, so a bare
    // "Save" reads as "save the whole form" (user-caught 2026-07-21).
    const saveBtn = NidaraButton({ label: t("settings.ai.brain.key.save"), variant: "primary", pill: true })
    const clearBtn = NidaraButton({ label: t("settings.ai.brain.key.clear"), pill: true })
    // Stacked row: the entry + its two buttons get the full width of the card. In
    // the trailing slot of a normal row the entry was squeezed to a stub.
    keyEntry.hexpand = true
    const keyBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    keyBox.append(keyEntry); keyBox.append(saveBtn); keyBox.append(clearBtn)
    const keyRow = createStackedRow(t("settings.ai.brain.key"), t("settings.ai.brain.key.desc"), keyBox)

    function refreshKeyUI() {
        const id = agentConfig.brainProvider
        const p = providerById(id)
        const needsKey = !!p && !p.local          // Ollama runs locally: no key to hold
        const avail = keyringAvailable()
        const stored = avail && hasKey(id)
        keyEntry.placeholder_text =
            !needsKey ? t("settings.ai.brain.key.placeholder") :
            !avail    ? t("settings.ai.brain.key.unavailable") :
            stored    ? t("settings.ai.brain.key.stored") :
                        t("settings.ai.brain.key.placeholder")
        keyEntry.sensitive = needsKey && avail
        saveBtn.sensitive = needsKey && avail
        clearBtn.sensitive = needsKey && avail && stored
    }

    const commitKey = () => {
        const k = keyEntry.get_text().trim()
        if (!k) return
        // The keyring may put a password dialog up (creating/unlocking the login
        // keyring). Disable the button meanwhile so the row reads as "working"
        // instead of dead, and let the async callback re-enable it.
        saveBtn.sensitive = false
        storeKey(agentConfig.brainProvider, k, (ok) => {
            if (ok) keyEntry.set_text("")
            refreshKeyUI()
        })
    }
    saveBtn.connect("clicked", commitKey)
    // Enter commits too — same gesture as every other field on this page.
    keyEntry.connect("activate", commitKey)
    clearBtn.connect("clicked", () => {
        clearBtn.sensitive = false
        clearKey(agentConfig.brainProvider, () => {
            keyEntry.set_text("")
            refreshKeyUI()
        })
    })

    // Row visibility per provider: the model is always editable (a stale default
    // must be a retype, never a dead end); the endpoint only for Custom (named
    // providers pin their own URL); the key for everything except local runtimes.
    function refreshSensitivity() {
        const p = providerById(agentConfig.brainProvider)
        model.row.sensitive = !!p
        endpoint.row.visible = !!p?.editableEndpoint
        keyRow.visible = !p || !p.local
        keyRow.sensitive = !!p && !p.local
        model.entry.set_text(agentConfig.brainModel)
        endpoint.entry.set_text(agentConfig.brainEndpoint)
        // A catalog belongs to the provider that answered it — drop it on every
        // switch, or Anthropic's list would sit there offering models to Ollama.
        modelDrop.visible = false
        modelStatus.visible = false
        refreshKeyUI()
    }

    brainGroup.listBox.append(dropdownRow(
        t("settings.ai.brain.provider"),
        t("settings.ai.brain.provider.desc"),
        labelFor(agentConfig.brainProvider),
        PROVIDERS.map(b => b.label),
        (v) => { agentConfig.setBrainProvider(idFor(v)); refreshSensitivity() },
        (apply) => agentConfig.onChange(() => apply(labelFor(agentConfig.brainProvider))),
    ))
    brainGroup.listBox.append(model.row)
    brainGroup.listBox.append(endpoint.row)
    brainGroup.listBox.append(keyRow)
    refreshSensitivity()

    page.append(brainGroup.box)

    // ── Desktop access — what agents may do to the shell itself ─────────────
    const accessGroup = listGroup(t("settings.ai.group.access"))

    accessGroup.listBox.append(toggleRow(
        t("settings.ai.allow-config-write"),
        t("settings.ai.allow-config-write.desc"),
        agentConfig.allowConfigWrite,
        (v) => agentConfig.setAllowConfigWrite(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowConfigWrite)),
    ))

    accessGroup.listBox.append(toggleRow(
        t("settings.ai.allow-screenshot"),
        t("settings.ai.allow-screenshot.desc"),
        agentConfig.allowScreenshot,
        (v) => agentConfig.setAllowScreenshot(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowScreenshot)),
    ))

    // The one gated window operation — the rest of the cluster (focus, move,
    // float, layout) is reversible and stays ungated.
    accessGroup.listBox.append(toggleRow(
        t("settings.ai.allow-window-close"),
        t("settings.ai.allow-window-close.desc"),
        agentConfig.allowWindowClose,
        (v) => agentConfig.setAllowWindowClose(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowWindowClose)),
    ))

    page.append(accessGroup.box)

    // ── Other apps — the computer-use layer (reaches OUTSIDE the shell) ──────
    const otherAppsGroup = listGroup(t("settings.ai.group.other-apps"))

    otherAppsGroup.listBox.append(toggleRow(
        t("settings.ai.allow-computer-use"),
        t("settings.ai.allow-computer-use.desc"),
        agentConfig.allowComputerUse,
        (v) => agentConfig.setAllowComputerUse(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowComputerUse)),
    ))

    otherAppsGroup.listBox.append(toggleRow(
        t("settings.ai.allow-computer-control"),
        t("settings.ai.allow-computer-control.desc"),
        agentConfig.allowComputerControl,
        (v) => agentConfig.setAllowComputerControl(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowComputerControl)),
    ))

    page.append(otherAppsGroup.box)

    // ── MCP server — the channel external clients connect through ────────────
    const mcpGroup = listGroup(t("settings.ai.group.mcp"))

    mcpGroup.listBox.append(toggleRow(
        t("settings.ai.allow-mcp"),
        t("settings.ai.allow-mcp.desc"),
        agentConfig.allowMcp,
        (v) => agentConfig.setAllowMcp(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowMcp)),
    ))

    mcpGroup.listBox.append(createRow(
        t("settings.ai.connect-agent"),
        t("settings.ai.connect-agent.desc"),
        staticLabel("~/.config/nidara/.mcp.json"),
    ))

    page.append(mcpGroup.box)

    // ── Agent interface — read-only facts about the surface ──────────────────
    const surfaceGroup = listGroup(t("settings.ai.group.surface"))

    surfaceGroup.listBox.append(createRow(
        t("settings.ai.exposed-settings"),
        t("settings.ai.exposed-settings.desc"),
        staticLabel(String(configKeys().length)),
    ))

    surfaceGroup.listBox.append(createRow(
        t("settings.ai.state-read"),
        t("settings.ai.state-read.desc"),
        staticLabel(""),
    ))

    page.append(surfaceGroup.box)

    return page
}
