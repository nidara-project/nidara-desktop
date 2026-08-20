import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Secret from "gi://Secret"
import { listGroup, pageBox, toggleRow, createRow, createStackedRow, dropdownRow, staticLabel, actionRow, fieldWithActions, bindWhileRealized, onPageShown } from "../SettingsHelpers"
import { NidaraButton, NidaraDropDown } from "../../../../lib/nidara-kit"
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

const KEYRING_TIMEOUT_MS = 12000

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
    let finished = false
    let timeoutId: number | null = null

    const finish = (ok: boolean) => {
        if (finished) return
        finished = true
        if (timeoutId !== null) {
            GLib.source_remove(timeoutId)
            timeoutId = null
        }
        done(ok)
    }

    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEYRING_TIMEOUT_MS, () => {
        timeoutId = null
        console.warn(`[Ai] keyring store timed out after ${KEYRING_TIMEOUT_MS}ms for provider ${provider}`)
        finish(false)
        return GLib.SOURCE_REMOVE
    })

    try {
        Secret.password_store(
            KEY_SCHEMA, { provider }, Secret.COLLECTION_DEFAULT,
            `Nidara Assistant — ${provider}`, key, null,
            (_src: any, res: any) => {
                let ok = false
                try { ok = Secret.password_store_finish(res) } catch (e) {
                    console.error("[Ai] keyring store failed:", e)
                }
                finish(ok)
            },
        )
    } catch (e) {
        console.error("[Ai] keyring store failed:", e)
        finish(false)
    }
}

function clearKey(provider: string, done: () => void): void {
    let finished = false
    let timeoutId: number | null = null

    const finish = () => {
        if (finished) return
        finished = true
        if (timeoutId !== null) {
            GLib.source_remove(timeoutId)
            timeoutId = null
        }
        done()
    }

    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEYRING_TIMEOUT_MS, () => {
        timeoutId = null
        console.warn(`[Ai] keyring clear timed out after ${KEYRING_TIMEOUT_MS}ms for provider ${provider}`)
        finish()
        return GLib.SOURCE_REMOVE
    })

    try {
        Secret.password_clear(KEY_SCHEMA, { provider }, null, (_src: any, res: any) => {
            try { Secret.password_clear_finish(res) } catch (e) {
                console.error("[Ai] keyring clear failed:", e)
            }
            finish()
        })
    } catch (e) {
        console.error("[Ai] keyring clear failed:", e)
        finish()
    }
}

// Settings → AI: governance of the agent-facing surface, plus the built-in
// Assistant's brain. Groups are ordered by WHAT a permission reaches — this
// desktop, then your files, then other apps — because that is the risk escalation
// a user is deciding about.
//
// But the axis the page kept silent about is WHO each group governs, and the two
// do not line up: the brain and the file layer are the built-in Assistant ALONE
// (the file tools are daemon-local — an MCP client brings its own), while config
// write / screenshot / window close / computer-use apply to EVERY agent, connected
// clients included. A user reading "Files" had no way to tell that it does not
// govern Claude Code. So every group carries a FOOTER naming its audience
// (`…group.*.scope`), which is the macOS/iOS idiom for scope a title can't hold.
// Keep footers about AUDIENCE; per-row explanation belongs in the row subtitle.
//
// Every row must gate, drive, or report something REAL — no placeholder toggles.
export default function AiPage() {
    const page = pageBox("ai-page")

    // ── Assistant — the built-in conversational agent's brain (BYOK) ─────────
    const brainGroup = listGroup(t("settings.ai.brain.group"), t("settings.ai.brain.group.scope"))

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
    const modelDrop = NidaraDropDown({ model: modelList, visible: false, valign: Gtk.Align.CENTER })
    let suppressDropCb = false
    // Index 0 is a PLACEHOLDER, not a model. GtkDropDown builds its own
    // GtkSingleSelection with `autoselect` on, which refuses to hold "nothing
    // selected" — set INVALID_LIST_POSITION and it snaps back to item 0. So the
    // catalog can't simply be left unselected: without a placeholder the first
    // model in the list always looks chosen, which reads as "this is your model"
    // for something the user never picked (user-caught 2026-07-22).
    //
    // And it RESTS on that placeholder forever: the dropdown is a menu you pick
    // from, not a second place the value lives. It used to preselect the
    // configured model, which put the same id in the entry AND in the list right
    // below it — one value shown twice, and the reason the pair read as
    // redundant (user-caught 2026-08-02). The entry above is the single display
    // of the value, and the id landing in it IS the confirmation that the pick
    // registered. Snapping back also makes re-picking the current model work,
    // which a sticky selection silently forbade (no `notify::selected` when the
    // chosen row is already selected — so retyping was the only way back to a
    // model you had strayed from).
    modelDrop.connect("notify::selected", () => {
        if (suppressDropCb) return
        // Row 0 selects nothing on purpose — never commit it over a real value.
        // It is also where we park ourselves after every pick, and that write
        // re-enters here: without the early-out it would commit the placeholder.
        if (modelDrop.selected === 0) return
        const item = modelList.get_string(modelDrop.selected)
        if (item) { modelEntry.set_text(item); commitModel() }
        // Back to "Choose a model…" — guarded, since this is a selection change
        // like any other and would otherwise re-enter the handler above.
        suppressDropCb = true
        modelDrop.selected = 0
        suppressDropCb = false
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
                modelList.append(t("settings.ai.brain.model.choose"))
                r.models.forEach(m => modelList.append(m))
                // Rests on the placeholder — the catalog never displays the
                // configured model, the entry above does. This used to preselect
                // it (matching on the BARE id, since a stored value may still
                // carry Google's `models/` prefix while the catalog is normalised
                // without it), which is precisely what showed one value twice.
                // Dropping the preselect drops that whole matching problem with
                // it: nothing here claims anything about your model any more.
                modelDrop.selected = 0
                suppressDropCb = false
                modelDrop.visible = true
                modelStatus.visible = false
            } else {
                modelDrop.visible = false
                modelStatus.label = t("settings.ai.brain.model.failed").replace("%s", r.error)
            }
        })
    })

    // One control per line: the id you are setting, the catalog that fills it once
    // "Find models" answers, then the action, then its status. All three used to
    // share a single row, so after a fetch an entry, a dropdown and a button
    // competed for one line and each got a stub of it (user-caught 2026-08-02).
    // The dropdown WRITES INTO the entry (see notify::selected) — it is a picker
    // for the field above it, not a second field, which is why it sits directly
    // under it rather than beside the button that populates it.
    modelEntry.hexpand = true
    modelDrop.hexpand = true
    const modelBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    modelBox.append(modelEntry)
    modelBox.append(modelDrop)
    modelBox.append(actionRow(fetchBtn))
    modelBox.append(modelStatus)
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
    const keyEntry = new Gtk.PasswordEntry({ show_peek_icon: true, valign: Gtk.Align.CENTER })
    // Labelled "Save key" / "Forget key", not "Save" / "Clear": this is the ONLY
    // button on a page where every other field commits on Enter/focus-out, so a bare
    // "Save" reads as "save the whole form" (user-caught 2026-07-21).
    const saveBtn = NidaraButton({ label: t("settings.ai.brain.key.save"), variant: "primary", pill: true })
    const clearBtn = NidaraButton({ label: t("settings.ai.brain.key.clear"), pill: true })
    // Says what the keyring just did. Storing is the one action on this page with
    // NO visible result: `Secret.password_store` REPLACES the item with the same
    // attributes, so overwriting a key clears the entry and restores the exact
    // "•••• stored" placeholder that was there before — identical to having done
    // nothing, or to a silent failure ("does it overwrite, does it add, what?" —
    // user, 2026-08-02). The answer now appears in the UI instead of only in
    // libsecret's semantics.
    const keyStatus = new Gtk.Label({
        css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.START, xalign: 0,
        wrap: true, visible: false,
    })
    const sayKey = (msg: string) => { keyStatus.label = msg; keyStatus.visible = true }

    // Buttons BENEATH the field, not beside it — see `fieldWithActions`. Forget
    // sits left of Save: right-aligned actions put the primary last.
    const keyBox = fieldWithActions(keyEntry, clearBtn, saveBtn)
    keyBox.append(keyStatus)
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
        // Read BEFORE the write: the store replaces in place, so afterwards there is
        // no way to tell a first save from an overwrite.
        const had = hasKey(agentConfig.brainProvider)
        // The keyring may put a password dialog up (creating/unlocking the login
        // keyring). Disable the button meanwhile so the row reads as "working"
        // instead of dead, and let the async callback re-enable it.
        saveBtn.sensitive = false
        storeKey(agentConfig.brainProvider, k, (ok) => {
            if (ok) keyEntry.set_text("")
            sayKey(!ok ? t("settings.ai.brain.key.failed")
                 : had ? t("settings.ai.brain.key.replaced")
                       : t("settings.ai.brain.key.saved"))
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
            sayKey(t("settings.ai.brain.key.cleared"))
            refreshKeyUI()
        })
    })

    // Row visibility per provider: the model is always editable (a stale default
    // must be a retype, never a dead end); the endpoint only for Custom (named
    // providers pin their own URL); the key for everything except local runtimes.
    //
    // 🔑 The provider is this group's CONTEXT, not one of its values: the model, the
    // endpoint row's visibility, the key row's visibility and every one of its
    // placeholders are derived from it. `shownProvider` is the one the widgets were
    // last built around, so a change made anywhere else can be recognised as a change
    // of context rather than of value.
    let shownProvider = agentConfig.brainProvider
    function refreshSensitivity() {
        shownProvider = agentConfig.brainProvider
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
        // Same reasoning for the key verdict: "Key replaced" is about the provider
        // that was selected when it was written, and keys are stored PER PROVIDER,
        // so leaving it up would claim something about the one just switched to.
        // (Not cleared in refreshKeyUI — commitKey calls that right after posting
        // its message, which would hide the verdict in the same tick.)
        keyStatus.visible = false
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

    // ⚠️ The provider dropdown's own `onExt` above moves the DROPDOWN and nothing else,
    // and everything else in this group belongs to the provider. There is one Settings
    // window per monitor, so switching provider on one screen used to leave the other
    // showing the previous provider's model, its endpoint row, and a key field that
    // still described it — while "Save key" (which reads the LIVE provider) would have
    // filed the secret under the new one. Re-derive the whole context when the provider
    // moves; when it hasn't, keep the two free-text fields honest without stealing what
    // someone is in the middle of typing.
    bindWhileRealized(page, () => {
        const sync = () => {
            if (agentConfig.brainProvider !== shownProvider) { refreshSensitivity(); return }
            if (!modelEntry.has_focus && modelEntry.get_text() !== agentConfig.brainModel)
                modelEntry.set_text(agentConfig.brainModel)
            if (!endpointEntry.has_focus && endpointEntry.get_text() !== agentConfig.brainEndpoint)
                endpointEntry.set_text(agentConfig.brainEndpoint)
        }
        sync()
        return agentConfig.onChange(sync)
    })

    // What the keyring holds is not a value this page owns — it is a QUESTION, and one
    // whose answer moves without any signal to hear: another Settings window, a
    // `secret-tool` from a terminal, or the Secret Service simply not being up yet when
    // the window was built (this page is built ONCE per window, so "Key storage
    // unavailable" would then stand for the rest of the session). Re-ask it whenever the
    // page is shown; `bindWhileRealized` would not, because hiding Settings leaves its
    // pages realized and reopening is how you come back to one.
    onPageShown(refreshKeyUI)

    page.append(brainGroup.box)

    // ── While it works — the signal, not a permission ────────────────────────
    // Its own group rather than a row among the gates: everything below grants
    // something, this only shows something. It is also the only setting on this
    // page that reaches outside the shell (it makes Nidara the owner of
    // Hyprland's decoration:glow), which is why it can be turned off.
    const signalGroup = listGroup(t("settings.ai.group.signal"), t("settings.ai.group.signal.scope"))

    signalGroup.listBox.append(toggleRow(
        t("settings.ai.assistant-glow"),
        t("settings.ai.assistant-glow.desc"),
        agentConfig.assistantGlow,
        (v) => agentConfig.setAssistantGlow(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.assistantGlow)),
    ))

    page.append(signalGroup.box)

    // ── Desktop access — what agents may do to the shell itself ─────────────
    const accessGroup = listGroup(t("settings.ai.group.access"), t("settings.ai.group.access.scope"))

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

    // ── Files — the built-in Assistant's own config-layer access ─────────────
    // Daemon-local (bin/nidara-agent), not an IPC action: external MCP clients
    // bring their own file tools. Reading is same-domain (Nidara's own config,
    // shipped defaults, the shell log); writing is opt-in because the writable
    // files exist to hold commands.
    const filesGroup = listGroup(t("settings.ai.group.files"), t("settings.ai.group.files.scope"))

    filesGroup.listBox.append(toggleRow(
        t("settings.ai.allow-file-read"),
        t("settings.ai.allow-file-read.desc"),
        agentConfig.allowFileRead,
        (v) => agentConfig.setAllowFileRead(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowFileRead)),
    ))

    filesGroup.listBox.append(toggleRow(
        t("settings.ai.allow-file-write"),
        t("settings.ai.allow-file-write.desc"),
        agentConfig.allowFileWrite,
        (v) => agentConfig.setAllowFileWrite(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowFileWrite)),
    ))

    page.append(filesGroup.box)

    // ── Other apps — the computer-use layer (reaches OUTSIDE the shell) ──────
    const otherAppsGroup = listGroup(t("settings.ai.group.other-apps"), t("settings.ai.group.other-apps.scope"))

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
    const mcpGroup = listGroup(t("settings.ai.group.mcp"), t("settings.ai.group.mcp.scope"))

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

    // The value is "always", and it has to be SAID. This row's group answers questions
    // about the surface with a fact in the trailing slot (the row above it prints a
    // count); this one printed an empty label, so the one row on the page whose whole
    // point is that no toggle can take it away was the row that answered nothing.
    surfaceGroup.listBox.append(createRow(
        t("settings.ai.state-read"),
        t("settings.ai.state-read.desc"),
        staticLabel(t("settings.ai.state-read.value")),
    ))

    page.append(surfaceGroup.box)

    return page
}
