import { listGroup, pageBox, settingRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function InputPage() {
    const page = pageBox("input-page")

    // ── Mouse ─────────────────────────────────────────────────────────────────
    const { box: mouseBox, listBox: mouseList } = listGroup(t("settings.input.mouse.group"))
    mouseList.append(settingRow("input.mouse.speed"))
    mouseList.append(settingRow("input.mouse.accel"))
    mouseList.append(settingRow("input.mouse.natural"))
    page.append(mouseBox)

    // ── Touchpad ──────────────────────────────────────────────────────────────
    const { box: touchBox, listBox: touchList } = listGroup(t("settings.input.touchpad.group"))
    touchList.append(settingRow("input.touchpad.natural"))
    touchList.append(settingRow("input.touchpad.tap"))
    page.append(touchBox)

    // ── Keyboard ──────────────────────────────────────────────────────────────
    const { box: kbBox, listBox: kbList } = listGroup(t("settings.input.keyboard.group"))
    kbList.append(settingRow("input.keyboard.layout"))
    kbList.append(settingRow("input.keyboard.numlock"))
    kbList.append(settingRow("input.keyboard.repeatDelay"))
    kbList.append(settingRow("input.keyboard.repeatRate"))
    page.append(kbBox)

    return page
}
