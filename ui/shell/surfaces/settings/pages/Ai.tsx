import { Gtk } from "ags/gtk4"
import Secret from "gi://Secret"
import { listGroup, pageBox, toggleRow, createRow, dropdownRow, staticLabel } from "../SettingsHelpers"
import { NidaraButton } from "../../../../lib/nidara-kit"
import agentConfig from "../../../core/AgentConfig"
import { configKeys } from "../../../core/ConfigRegistry"
import { t } from "../../../core/i18n"

// The built-in Assistant's API key lives in the DE keyring (libsecret), never in
// ai.json. One entry per backend (attribute `backend`), so a user can keep both an
// Anthropic and an OpenAI-compatible key. bin/nidara-agent reads it back with the
// same schema. All calls are fail-soft: a Nidara session may have no Secret Service
// running yet (gnome-keyring is unlocked at login via PAM — see install.sh), and the
// page must never crash the shell when the keyring is unavailable.
const KEY_SCHEMA = Secret.Schema.new(
    "org.nidara.Assistant",
    Secret.SchemaFlags.NONE,
    { backend: Secret.SchemaAttributeType.STRING },
)

function keyringAvailable(): boolean {
    // A lookup for a non-existent attribute returns null when the service is up and
    // throws when it's down — the cheapest liveness probe.
    try {
        Secret.password_lookup_sync(KEY_SCHEMA, { backend: "__probe__" }, null)
        return true
    } catch {
        return false
    }
}

function hasKey(backend: string): boolean {
    if (!backend) return false
    try {
        return !!Secret.password_lookup_sync(KEY_SCHEMA, { backend }, null)
    } catch {
        return false
    }
}

function storeKey(backend: string, key: string): boolean {
    try {
        return Secret.password_store_sync(
            KEY_SCHEMA, { backend }, Secret.COLLECTION_DEFAULT,
            `Nidara Assistant — ${backend}`, key, null,
        )
    } catch (e) {
        console.error("[Ai] keyring store failed:", e)
        return false
    }
}

function clearKey(backend: string): void {
    try {
        Secret.password_clear_sync(KEY_SCHEMA, { backend }, null)
    } catch (e) {
        console.error("[Ai] keyring clear failed:", e)
    }
}

// Free-text setting row committing on Enter or focus-out (never per-keystroke — the
// setter writes ai.json). A blanked field reverts to the stored value.
function entryRow(
    label: string,
    subtitle: string,
    get: () => string,
    set: (v: string) => void,
): { row: Gtk.Widget; entry: Gtk.Entry } {
    const entry = new Gtk.Entry({ text: get(), valign: Gtk.Align.CENTER, width_chars: 22 })
    const commit = () => {
        const v = entry.get_text().trim()
        if (v && v !== get()) set(v)
        else if (!v) entry.set_text(get())
    }
    entry.connect("activate", commit)
    const focus = new Gtk.EventControllerFocus()
    focus.connect("leave", commit)
    entry.add_controller(focus)
    return { row: createRow(label, subtitle, entry), entry }
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

    // Backend picker. Display labels ↔ stored ids ("" | "anthropic" | "openai").
    const BACKENDS: Array<{ id: "" | "anthropic" | "openai"; label: string }> = [
        { id: "",          label: t("settings.ai.brain.backend.off") },
        { id: "anthropic", label: t("settings.ai.brain.backend.anthropic") },
        { id: "openai",    label: t("settings.ai.brain.backend.openai") },
    ]
    const labelFor = (id: string) => BACKENDS.find(b => b.id === id)?.label ?? BACKENDS[0].label
    const idFor = (label: string) => BACKENDS.find(b => b.label === label)?.id ?? ""

    // Model + endpoint + key rows are built first so the backend cb can toggle them.
    const model = entryRow(
        t("settings.ai.brain.model"),
        t("settings.ai.brain.model.desc"),
        () => agentConfig.brainModel,
        (v) => agentConfig.setBrainModel(v),
    )
    const endpoint = entryRow(
        t("settings.ai.brain.endpoint"),
        t("settings.ai.brain.endpoint.desc"),
        () => agentConfig.brainEndpoint,
        (v) => agentConfig.setBrainEndpoint(v),
    )

    // API key row: a password entry + save/clear, status carried in the placeholder
    // (the stored key is never re-shown).
    const keyEntry = new Gtk.PasswordEntry({ show_peek_icon: true, valign: Gtk.Align.CENTER, width_chars: 16 })
    const saveBtn = NidaraButton({ label: t("settings.ai.brain.key.save"), variant: "primary", pill: true })
    const clearBtn = NidaraButton({ label: t("settings.ai.brain.key.clear"), pill: true })
    const keyBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    keyBox.append(keyEntry); keyBox.append(saveBtn); keyBox.append(clearBtn)
    const keyRow = createRow(t("settings.ai.brain.key"), t("settings.ai.brain.key.desc"), keyBox)

    function refreshKeyUI() {
        const b = agentConfig.brainBackend
        const avail = keyringAvailable()
        const stored = avail && hasKey(b)
        keyEntry.placeholder_text =
            !b       ? t("settings.ai.brain.key.placeholder") :
            !avail   ? t("settings.ai.brain.key.unavailable") :
            stored   ? t("settings.ai.brain.key.stored") :
                       t("settings.ai.brain.key.placeholder")
        keyEntry.sensitive = !!b && avail
        saveBtn.sensitive = !!b && avail
        clearBtn.sensitive = !!b && avail && stored
    }

    saveBtn.connect("clicked", () => {
        const k = keyEntry.get_text().trim()
        if (!k) return
        if (storeKey(agentConfig.brainBackend, k)) {
            keyEntry.set_text("")
            refreshKeyUI()
        }
    })
    clearBtn.connect("clicked", () => {
        clearKey(agentConfig.brainBackend)
        keyEntry.set_text("")
        refreshKeyUI()
    })

    // Enable rows per backend: model + key for any provider; endpoint only for the
    // OpenAI-compatible backend (Anthropic ignores it).
    function refreshSensitivity() {
        const b = agentConfig.brainBackend
        model.row.sensitive = b !== ""
        endpoint.row.sensitive = b === "openai"
        keyRow.sensitive = b !== ""
        refreshKeyUI()
    }

    brainGroup.listBox.append(dropdownRow(
        t("settings.ai.brain.backend"),
        t("settings.ai.brain.backend.desc"),
        labelFor(agentConfig.brainBackend),
        BACKENDS.map(b => b.label),
        (v) => { agentConfig.setBrainBackend(idFor(v)); refreshSensitivity() },
        (apply) => agentConfig.onChange(() => apply(labelFor(agentConfig.brainBackend))),
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
