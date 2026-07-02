import { listGroup, pageBox, toggleRow, createRow, staticLabel } from "../SettingsHelpers"
import agentConfig from "../../../core/AgentConfig"
import { configKeys } from "../../../core/ConfigRegistry"
import { t } from "../../../core/i18n"

// Settings → AI: governance of the agent-facing surface. Four groups, one
// concept each: what agents may do to THIS desktop (shell-scoped, default on),
// what they may do to OTHER apps (computer-use, escalating, default off), the
// MCP channel (server toggle + connection file — a transport, not a
// permission: the capability toggles gate `ags request` and MCP alike), and
// read-only interface facts. Every row must gate or report something REAL —
// no placeholder toggles. Grows with the AI-native roadmap (assistant model
// picker…).
export default function AiPage() {
    const page = pageBox("ai-page")

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
