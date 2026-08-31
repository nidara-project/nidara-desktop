import { listGroup, pageBox, settingRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function AccessibilityPage() {
    const page = pageBox("accessibility-page")

    // ── Vision ────────────────────────────────────────────────────────────────
    const visionGroup = listGroup(t("settings.accessibility.group.vision"))

    visionGroup.listBox.append(settingRow("accessibility.textScale"))
    visionGroup.listBox.append(settingRow("accessibility.cursorSize"))

    page.append(visionGroup.box)

    // ── Motion ────────────────────────────────────────────────────────────────
    const motionGroup = listGroup(t("settings.accessibility.group.motion"))

    motionGroup.listBox.append(settingRow("accessibility.reduceMotion"))

    page.append(motionGroup.box)

    return page
}

