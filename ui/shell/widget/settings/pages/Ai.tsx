import { listGroup, pageBox, toggleRow, createRow, staticLabel } from "../SettingsHelpers"
import agentConfig from "../../../core/AgentConfig"
import { configKeys } from "../../../core/ConfigRegistry"
import { t } from "../../../core/i18n"

// Settings → AI: governance of the agent-facing surface. This page grows with
// the AI-native roadmap (MCP server on/off, assistant model picker); every row
// must gate something REAL — no placeholder toggles.
export default function AiPage() {
    const page = pageBox("ai-page")

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

    accessGroup.listBox.append(toggleRow(
        t("settings.ai.allow-mcp"),
        t("settings.ai.allow-mcp.desc"),
        agentConfig.allowMcp,
        (v) => agentConfig.setAllowMcp(v),
        (apply) => agentConfig.onChange(() => apply(agentConfig.allowMcp)),
    ))

    page.append(accessGroup.box)

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
