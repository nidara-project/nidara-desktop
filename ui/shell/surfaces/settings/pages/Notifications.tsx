import { listGroup, pageBox, settingRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function NotificationsPage() {
    const page = pageBox("notifications-page")

    // ── Do not disturb ────────────────────────────────────────────────────────
    // Headerless group, first on the page: this is the same bit the Control
    // Center's focus tile flips. Popup behaviour follows below.
    const dndGroup = listGroup("")

    dndGroup.listBox.append(settingRow("notifications.doNotDisturb"))

    page.append(dndGroup.box)

    const popupsGroup = listGroup(t("settings.notif.group.popups"))

    popupsGroup.listBox.append(settingRow("notifications.popupTimeout"))

    page.append(popupsGroup.box)

    return page
}

